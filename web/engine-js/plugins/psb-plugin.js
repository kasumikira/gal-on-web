import { nativeClass, nativeMethod, nativeProperty } from '#krkr/native';
import { PSBFile as PSBFileReader, decodePSBContainer } from './psb.js';
import { registerPSBMedia } from './psb-media.js';
import { psbVariant } from './psb-value.js';

export function registerPSBFile({ storage, registerGlobal }) {
  if (storage) registerPSBMedia(storage);
  @nativeClass('PSBFile')
  class PSBFile {
    static initialize() { return { file: null }; }

    @nativeMethod async PSBFile(value) {
      if (arguments.length) await PSBFile.members.get('load').call(this, value);
    }
    @nativeMethod async load(value) {
      if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new Error('invalid argument for PSBFile.load()');
      const bytes = await decodePSBContainer(typeof value === 'string' ? await storage.read(value) : value.slice());
      try { this.file = new PSBFileReader(bytes); }
      catch (error) { throw new Error(`${error.message} (${typeof value === 'string' ? value : 'octet'})`); }
      return 1;
    }
    @nativeProperty get root() { return psbVariant(this.file?.root); }
  }
  registerGlobal('PSBFile', PSBFile);
}


