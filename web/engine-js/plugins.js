import { TextStreamDecoder } from './text-stream.js';
import { reportUnimplemented } from '#krkr/native';
import { registerFstat } from './plugins/fstat.js';
import { registerCSVParser } from './plugins/csvparser.js';
import { registerMotion } from './plugins/motion.js';
import { registerPSBFile } from './plugins/psb-plugin.js';
import { registerExtrans } from './plugins/extrans.js';
import { registerTextRender } from './plugins/textrender.js';
import { registerLayerExDraw } from './plugins/layerex-draw.js';
import { registerGamepad } from './plugins/gamepad.js';

// The native distribution exposes these plugin entry points even when a game
// does not use every one of them. Unported entries report their status without
// installing placeholder APIs on unrelated classes.
const emptyPluginNames = [
  'alphamovie.dll', 'drawdeviced3d.dll', 'drawdeviced3dz.dll',
  'extkagparser.dll', 'kagparserex.dll', 'kagparserexb.dll',
  'kaichotrans.dll', 'layereximage.dll',
  'layerexsave.dll', 'packinone.dll',
  'addfont.dll', 'dirlist.dll', 'expat.dll', 'extnagano.dll',
  'getabout.dll', 'getsample.dll', 'gfxeffect.dll', 'json.dll',
  'fftgraph.dll', 'kirikiroid2.dll', 'layerexalpha.dll',
  'layerexareaaverage.dll', 'layerexbtoa.dll', 'layerexmovie.dll',
  'layerexraster.dll', 'layerexshimmer.dll', 'lzfs.dll',
  'minizip.dll', 'multiimage.dll', 'perspective.dll',
  'savestruct.dll', 'scriptsex.dll',
  'shrinkcopy.dll', 'sqlite3.dll', 'util_generic.dll',
  'util_graph.dll', 'util_system.dll', 'varfile.dll',
  'win32dialog.dll', 'windowex.dll', 'wutcwf.dll', 'xp3filter.dll',
];

// Ogg decoding is handled by WaveSoundBuffer.open through Web Audio, with both
// Vorbis and Opus gain-query callbacks already exposed by the browser backend.
const browserBackedPluginNames = ['wuvorbis.dll', 'wuopus.dll'];
const registerBrowserBackedPlugin = () => {};

const builtinPlugins = [
  ...emptyPluginNames.map(name => ({ names: [name], load: () => reportUnimplemented(`Plugins.link("${name}"): 插件尚未实现`) })),
  ...browserBackedPluginNames.map(name => ({ names: [name], load: registerBrowserBackedPlugin })),
  { names: ['fstat.dll'], load: registerFstat },
  { names: ['csvparser.dll'], load: context => {
    const decoder = new TextStreamDecoder();
    return registerCSVParser(context, async name => decoder.read(await context.storage.read(name)));
  } },
  { names: ['psbfile.dll'], load: registerPSBFile },
  { names: ['motionplayer.dll', 'emoteplayer.dll'], load: registerMotion },
  { names: ['extrans.dll'], load: registerExtrans },
  { names: ['textrender.dll'], load: registerTextRender },
  { names: ['layerexdraw.dll'], load: registerLayerExDraw },
  { names: ['gamepad.dll'], load: registerGamepad },
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
