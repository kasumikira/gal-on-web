import { nativeClass, nativeMethod } from '#krkr/native';
import { Closure, truth, integer, number } from '#krkr/values';

// D3DAdaptor's script API also exists on the reference software renderer.
// Target texture dimensions remain fixed when setSize changes logical size.
export function createMotionD3DAdaptorClass() {
  const int=value=>Number(BigInt.asIntN(32,integer(value)));
  const requireArgs=(args,count)=>{if(args.length<count)throw new Error(`Motion.D3DAdaptor requires ${count} arguments`);};

  @nativeClass('D3DAdaptor')
  class D3DAdaptor {
    static initialize() {
      return {
        width:0,height:0,centerX:0,centerY:0,visible:0,alphaOpAdd:0,
        canvasCaptureEnabled:0,clearEnabled:1,resizable:0,clearColor:0,
        softwareTextureCopies:new Map(),
      };
    }

    @nativeMethod D3DAdaptor(...args) {
      if(args.length===1&&args[0]===undefined){D3DAdaptor.instances.delete(this);return;}
      requireArgs(args,5);
      const window=args[0] instanceof Closure?args[0].object:args[0];
      if(!window?.classNames?.has('Window'))throw new Error('must set Window object');
      const s=this;
      s.window=window;s.width=int(args[1]);s.height=int(args[2]);s.centerX=int(args[3]);s.centerY=int(args[4]);
      s.textureWidth=s.width>>>0;s.textureHeight=s.height>>>0;
      s.pixels=new Uint8Array(s.textureWidth*s.textureHeight*4);
    }
    @nativeMethod setSize(...args) {requireArgs(args,2);const s=this;s.width=int(args[0]);s.height=int(args[1]);}
    @nativeMethod setClearColor(...args) {requireArgs(args,1);this.clearColor=int(args[0]);}
    @nativeMethod setResizable(...args) {requireArgs(args,1);this.resizable=Number(truth(args[0]));}
    @nativeMethod removeAllTextures() {this.softwareTextureCopies.clear();}
    // These are intentional nullsubs in the original, with typed conversion.
    @nativeMethod setPos(...args) {requireArgs(args,2);this;int(args[0]);int(args[1]);}
    @nativeMethod removeAllBg() {this;}
    @nativeMethod removeAllCaption() {this;}
    @nativeMethod unloadUnusedTextures() {this;}
    @nativeMethod registerBg(...args) {requireArgs(args,5);this;Math.fround(number(args[1]));Math.fround(number(args[2]));Math.fround(number(args[3]));truth(args[4]);}
    @nativeMethod registerCaption(...args) {requireArgs(args,3);this;Math.fround(number(args[1]));Math.fround(number(args[2]));}
  }
  for(const name of ['visible','alphaOpAdd','canvasCaptureEnabled','clearEnabled']) {
    D3DAdaptor.defineProperty(name,owner=>D3DAdaptor.state(owner)[name],(owner,value)=>{D3DAdaptor.state(owner)[name]=Number(truth(value));});
  }
  return D3DAdaptor;
}
