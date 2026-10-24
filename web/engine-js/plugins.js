import { reportUnimplemented } from '#krkr/native';
import { registerFstat } from './plugins/fstat.js';
import { registerAlphaMovie } from './plugins/alphamovie.js';
import { registerPSBFile } from './plugins/psb-plugin.js';
import { registerMotion } from './plugins/motion.js';
import { registerExtrans } from './plugins/extrans.js';
import { registerTextRender } from './plugins/textrender.js';
import { registerLayerExDraw } from './plugins/layerex-draw.js';
import { registerGamepad } from './plugins/gamepad.js';
import { registerGetSample } from './plugins/getsample.js';
import { registerGetAbout } from './plugins/getabout.js';
import { registerWindowEx } from './plugins/windowex.js';
import { registerPackinOne } from './plugins/packinone.js';
import { registerWin32Dialog } from './plugins/win32dialog.js';
import { registerFftGraph } from './plugins/fftgraph.js';
import { registerKirikiroid2 } from './plugins/kirikiroid2.js';
import { registerDirList } from './plugins/dirlist.js';
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
  'expat.dll', 'extnagano.dll',
  'gfxeffect.dll', 'json.dll',
  'layerexalpha.dll',
  'layerexareaaverage.dll', 'layerexmovie.dll',
  'layerexshimmer.dll', 'lzfs.dll',
  'minizip.dll', 'multiimage.dll', 'perspective.dll',
  'sqlite3.dll', 'util_generic.dll',
  'util_graph.dll', 'util_system.dll', 'varfile.dll',
  'wutcwf.dll', 'xp3filter.dll',
];

// Ogg decoding is handled by WaveSoundBuffer.open through Web Audio, with both
// Vorbis and Opus gain-query callbacks already exposed by the browser backend.
const browserBackedPluginNames = ['wuvorbis.dll', 'wuopus.dll'];
const registerBrowserBackedPlugin = () => {};
// Plugins whose interface the core already provides: addFont.cpp attaches
// System.addFont, which system.js implements with FontFace. ScriptsEx's
// complete interface is registered by C++ when the runtime creates Scripts.
// csvParser.dll and saveStruct.dll register from C++ at runtime creation
// (native/kirikiri/plugins/csvParser.cpp and saveStruct.cpp), so their
// globals and Array/Dictionary members exist before any script runs.
const coreBackedPluginNames = [
  'addfont.dll', 'scriptsex.dll', 'csvparser.dll', 'savestruct.dll',
];
const registerCoreBackedPlugin = () => {};

const builtinPlugins = [
  ...emptyPluginNames.map(name => ({ names: [name], load: () => reportUnimplemented(`Plugins.link("${name}"): 插件尚未实现`) })),
  ...browserBackedPluginNames.map(name => ({ names: [name], load: registerBrowserBackedPlugin })),
  ...coreBackedPluginNames.map(name => ({ names: [name], load: registerCoreBackedPlugin })),
  { names: ['fstat.dll'], load: registerFstat },
  { names: ['alphamovie.dll'], load: registerAlphaMovie },
  { names: ['psbfile.dll'], load: registerPSBFile },
  { names: ['motionplayer.dll', 'emoteplayer.dll'], load: registerMotion },
  { names: ['extrans.dll'], load: registerExtrans },
  { names: ['textrender.dll'], load: registerTextRender },
  { names: ['layerexdraw.dll'], load: registerLayerExDraw },
  { names: ['gamepad.dll'], load: registerGamepad },
  { names: ['getsample.dll'], load: registerGetSample },
  { names: ['getabout.dll'], load: registerGetAbout },
  { names: ['windowex.dll'], load: registerWindowEx },
  { names: ['packinone.dll'], load: registerPackinOne },
  { names: ['win32dialog.dll'], load: registerWin32Dialog },
  { names: ['fftgraph.dll'], load: registerFftGraph },
  { names: ['kirikiroid2.dll'], load: registerKirikiroid2 },
  { names: ['dirlist.dll'], load: registerDirList },
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
    if (this.loaded.has(key)) return;
    const load = this.modules.get(key);
    if (!load) {
      reportUnimplemented(`Plugins.link("${key}"): 插件入口未注册`);
      return;
    }
    const unload = await load(this.context);
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
  getList() {
    const result = [];
    result.push(...Array.from(this.loaded).sort());
    return result;
  }
}



