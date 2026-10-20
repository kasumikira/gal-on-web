// PackinOne.cpp: the batch loader has no API of its own; linking it links the
// eight bundled plugins in this order. Sub-plugins that are still missing report
// themselves through Plugins.link, exactly as they would when a game links them
// by name.
const bundledPlugins = [
  'fstat.dll',
  'savestruct.dll',
  'scriptsex.dll',
  'shrinkcopy.dll',
  'layerexbtoa.dll',
  'layereximage.dll',
  'layerexraster.dll',
  'csvparser.dll',
];

export async function registerPackinOne({ link }) {
  for (const name of bundledPlugins) await link(name);
}
