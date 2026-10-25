import { reportUnimplemented } from '#krkr/native';
import { registerAlphaMovie } from './plugins/alphamovie.js';
import { registerPSBMedia } from './plugins/psb-media.js';
import { registerMotion } from './plugins/motion.js';
import { registerExtrans } from './plugins/extrans.js';
import { registerLayerExDraw } from './plugins/layerex-draw.js';
import { registerGamepad } from './plugins/gamepad.js';
import { registerGetSample } from './plugins/getsample.js';
import { registerGetAbout } from './plugins/getabout.js';
import { registerWindowEx } from './plugins/windowex.js';
import { registerPackinOne } from './plugins/packinone.js';
import { registerWin32Dialog } from './plugins/win32dialog.js';
import { registerFftGraph } from './plugins/fftgraph.js';
import { registerShrinkCopy } from './plugins/shrinkcopy.js';
import { registerLayerExRaster } from './plugins/layerexraster.js';
import { registerLayerExBTOA } from './plugins/layerexbtoa.js';

// The native distribution exposes these plugin entry points even when a game
// does not use every one of them. Unported entries report their status without
// installing placeholder APIs on unrelated classes.
const emptyPluginNames = [
  'drawdeviced3d.dll', 'drawdeviced3dz.dll',
  'extkagparser.dll', 'kagparserex.dll', 'kagparserexb.dll',
  'kaichotrans.dll', 'layereximage.dll',
  'layerexsave.dll',
  'extnagano.dll',
  'gfxeffect.dll',
  'layerexalpha.dll',
  'layerexareaaverage.dll', 'layerexmovie.dll',
  'layerexshimmer.dll', 'lzfs.dll',
  'minizip.dll', 'multiimage.dll', 'perspective.dll',
  'sqlite3.dll', 'util_generic.dll',
  'util_graph.dll', 'util_system.dll', 'varfile.dll',
  'wutcwf.dll',
];

// Ogg decoding is handled by WaveSoundBuffer.open through Web Audio, with both
// Vorbis and Opus gain-query callbacks already exposed by the browser backend.
const browserBackedPluginNames = ['wuvorbis.dll', 'wuopus.dll'];
const registerBrowserBackedPlugin = () => {};
// System.addFont is supplied by the browser backend.
const coreBackedPluginNames = ['addfont.dll'];
const registerCoreBackedPlugin = () => {};

const builtinPlugins = [
  ...emptyPluginNames.map(name => ({ names: [name], load: () => reportUnimplemented(`Plugins.link("${name}"): 插件尚未实现`) })),
  ...browserBackedPluginNames.map(name => ({ names: [name], load: registerBrowserBackedPlugin })),
  ...coreBackedPluginNames.map(name => ({ names: [name], load: registerCoreBackedPlugin })),
  { names: ['alphamovie.dll'], load: registerAlphaMovie },
  { names: ['psbfile.dll'], load: ({ storage }) => { if (storage) registerPSBMedia(storage); } },
  { names: ['motionplayer.dll', 'emoteplayer.dll'], load: registerMotion },
  { names: ['extrans.dll'], load: registerExtrans },
  { names: ['layerexdraw.dll'], load: registerLayerExDraw },
  { names: ['gamepad.dll'], load: registerGamepad },
  { names: ['getsample.dll'], load: registerGetSample },
  { names: ['getabout.dll'], load: registerGetAbout },
  { names: ['windowex.dll'], load: registerWindowEx },
  { names: ['packinone.dll'], load: registerPackinOne },
  { names: ['win32dialog.dll'], load: registerWin32Dialog },
  { names: ['fftgraph.dll'], load: registerFftGraph },
  { names: ['shrinkcopy.dll'], load: registerShrinkCopy },
  { names: ['layerexraster.dll'], load: registerLayerExRaster },
  { names: ['layerexbtoa.dll'], load: registerLayerExBTOA },
];

export class Plugins {
  constructor(context, modules = builtinPlugins) {
    this.context = context;
    this.modules = new Map();
    this.loaded = new Set();
    this.unloaders = new Map();
    // Game plugin files occupy the manifest's /plugin/ virtual directory.
    this.pluginPathName = '/plugin/';
    for (const module of modules) this.register(module);
  }
  register(module, callback) {
    if (typeof module === 'string') {
      this.modules.set(module.toLowerCase(), callback);
      return;
    }
    if (typeof module?.load !== 'function' || !module.names?.length) throw new Error('Invalid plugin module');
    for (const name of module.names) this.modules.set(String(name).toLowerCase(), module.load);
  }
  async link(name) {
    if (!arguments.length) throw new Error('Plugins.link requires a name');
    const key = String(name).toLowerCase();
    const native = await this.context.nativePlugins?.(0, key);
    if (this.loaded.has(key)) return;
    const load = this.modules.get(key);
    if (!native && !load) {
      reportUnimplemented(`Plugins.link("${key}"): 插件入口未注册`);
      return;
    }
    const unload = await load?.(this.context);
    if (typeof unload === 'function') this.unloaders.set(key, unload);
    this.loaded.add(key);
  }
  async unlink(name) {
    if (!arguments.length) throw new Error('Plugins.unlink requires a name');
    const key = String(name).toLowerCase(), unload = this.unloaders.get(key);
    if (unload) {
      await unload();
      this.unloaders.delete(key);
      this.loaded.delete(key);
    }
    return 1;
  }
  async getList() {
    const native = await this.context.nativePlugins?.(1) ?? [];
    return [...new Set([...this.loaded, ...native])].sort();
  }
}



