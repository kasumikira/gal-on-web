import { PhaseVocoderDSP } from './phase-vocoder-core.js';

class PCMSource {
  constructor(channels,position,looping) { this.channels=channels; this.position=position; this.looping=looping; }
  read(count) {
    const length=this.channels[0].length;
    if (!length) return this.channels.map(()=>new Float32Array());
    const written=this.looping ? count : Math.min(count,length-this.position);
    const result=this.channels.map(()=>new Float32Array(written));
    for(let i=0;i<written;i++) {
      for(let ch=0;ch<result.length;ch++) result[ch][i]=this.channels[ch][this.position];
      if(++this.position===length && this.looping) this.position=0;
    }
    return result;
  }
}
class PhaseSource {
  constructor(source,config,channels) {
    this.source=source; this.config=config;
    this.dsp=new PhaseVocoderDSP(config.window,channels);
    this.input=Array.from({length:channels},()=>new Float32Array(config.window));
    this.filled=0; this.pending=null; this.pendingIndex=0; this.ended=false;
  }
  read(count) {
    const result=this.input.map(()=>new Float32Array(count));
    let written=0;
    while(written<count) {
      if(!this.pending || this.pendingIndex===this.pending[0].length) {
        if(this.ended) break;
        this.dsp.configure(this.config);
        const required=this.dsp.size-this.filled, next=this.source.read(required), available=next[0].length;
        if(!available) { this.ended=true; break; }
        for(let ch=0;ch<this.input.length;ch++) this.input[ch].set(next[ch],this.filled);
        this.filled+=available;
        if(available<required) {
          const padded=Math.ceil(this.filled/this.dsp.inputHop)*this.dsp.inputHop;
          for(const channel of this.input) channel.fill(0,this.filled,padded);
          this.filled=padded;
          if(this.filled<this.dsp.size) { this.ended=true; break; }
        }
        this.pending=this.dsp.process(this.input); this.pendingIndex=0;
        for(const channel of this.input) channel.copyWithin(0,this.dsp.inputHop);
        this.filled-=this.dsp.inputHop;
      }
      const copy=Math.min(count-written,this.pending[0].length-this.pendingIndex);
      for(let ch=0;ch<result.length;ch++) result[ch].set(this.pending[ch].subarray(this.pendingIndex,this.pendingIndex+copy),written);
      written+=copy; this.pendingIndex+=copy;
    }
    return result.map(channel=>channel.subarray(0,written));
  }
}

class WaveProcessor extends AudioWorkletProcessor {
  constructor({processorOptions:options}) {
    super();
    this.pcm=new PCMSource(options.channels,options.position,options.looping);
    this.source=this.pcm; this.filters=[];
    for(const config of options.filters) {
      const filter=new PhaseSource(this.source,config,options.channels.length);
      this.filters.push(filter); this.source=filter;
    }
    this.frequency=options.frequency; this.inputRate=options.sampleRate;
    this.stash=options.channels.map(()=>new Float32Array()); this.cursor=0; this.ended=false;
    // Paused suppresses output without tearing down the DSP state; the
    // position is frozen in place (WaveImpl.cpp FillBuffer's allowpause path).
    this.paused=false;
    this.port.onmessage=({data})=>{
      if(data.type==='stop') this.ended=true;
      else if(data.type==='pause') this.paused=true;
      else if(data.type==='start') this.paused=false;
      else if(data.type==='frequency') this.frequency=data.value;
      else if(data.type==='looping') this.pcm.looping=data.value;
      else if(data.type==='filter') this.filters[data.index].config=data.value;
    };
  }
  process(_inputs,outputs) {
    if(this.ended) return false;
    const output=outputs[0], ratio=this.frequency/sampleRate;
    if(this.paused) { for(const channel of output) channel.fill(0); return true; }
    for(let i=0;i<output[0].length;i++) {
      while(Math.floor(this.cursor)+1>=this.stash[0].length) {
        const start=Math.floor(this.cursor), next=this.source.read(128);
        this.cursor-=start;
        this.stash=this.stash.map((old,ch)=>{
          const retained=old.subarray(start), joined=new Float32Array(retained.length+next[ch].length);
          joined.set(retained); joined.set(next[ch],retained.length); return joined;
        });
        if(!next[0].length) break;
      }
      const index=Math.floor(this.cursor), fraction=this.cursor-index;
      if(index>=this.stash[0].length) {
        this.ended=true; this.port.postMessage({type:'ended'}); return false;
      }
      for(let ch=0;ch<output.length;ch++) {
        const channel=this.stash[ch];
        output[ch][i]=channel[index]+fraction*((channel[index+1]??0)-channel[index]);
      }
      this.cursor+=ratio;
    }
    this.port.postMessage({type:'position',value:this.pcm.position});
    return true;
  }
}
registerProcessor('krkr-wave',WaveProcessor);
