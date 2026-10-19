import { config } from '../global.js';
import { nativeClass, nativeMethod, nativeProperty, defineNativeClass, installNativeStubs, unimplemented } from '#krkr/native';
import { motionClasses } from '#krkr/native-api';
import { createMotionPlayerClass, createMotionResourceManagerClass } from './motion-player.js';
import { createMotionD3DAdaptorClass } from './motion-d3d-adaptor.js';

// Motion's root registrar is a namespace class without a usable constructor.
// Values follow Player.h, including the original Recutangular spelling.
// ResourceManager needs the engine storage system, so it is created by the
// runtime and attached here.
export function createMotionClass({ storage, getLayerNode, report, document } = {}) {
  const constants = {
    LayerTypeObj: 0, LayerTypeShape: 1, LayerTypeLayout: 2, LayerTypeMotion: 3,
    LayerTypeParticle: 4, LayerTypeCamera: 5,
    ShapeTypePoint: 0, ShapeTypeCircle: 1, ShapeTypeRect: 2, ShapeTypeQuad: 3,
    PlayFlagForce: 1, PlayFlagChain: 2, PlayFlagAsCan: 4, PlayFlagJoin: 8, PlayFlagStealth: 16,
    TransformOrderFlip: 0, TransformOrderSlant: 3, TransformOrderZoom: 2, TransformOrderAngle: 1,
    CoordinateRecutangularXY: 0, CoordinateRecutangularXZ: 1,
    MaskModeStencil: 0, MaskModeAlpha: 1,
  };
  @nativeClass('Motion')
  class Motion {
    @nativeMethod Motion() { throw new Error('TJS Motion constructor is not implemented by the native engine'); }
    // Capability follows the renderer, independently of the adaptor class.
    @nativeMethod getD3DAvailable() { return 0; }
  }
  for (const [name, value] of Object.entries(constants)) Motion.members.set(name, value);
  Motion.members.set('D3DAdaptor', createMotionD3DAdaptorClass());
  if (storage) {
    const manager = createMotionResourceManagerClass(storage);
    Motion.members.set('ResourceManager', manager);
    Motion.members.set('Player', createMotionPlayerClass({ ResourceManager: manager, getLayerNode, report, document }));
    Motion.members.set('EmotePlayer', createEmotePlayerShim(manager));
  }
  for (const name of motionClasses) {
    if (!Motion.members.has(name)) {
      Motion.members.set(name, defineNativeClass(name, { initialize: unimplemented(`Motion.${name}: 原生类尚未实现`) }));
    }
    installNativeStubs(Motion.members.get(name), `Motion.${name}`);
  }
  installNativeStubs(Motion, 'Motion.Motion');
  return Motion;
}

export function registerMotion({ global, storage, get, registerGlobal }) {
  const { document, inform } = config;
  const Layer = get('Layer');
  if (!global.Motion) registerGlobal('Motion', createMotionClass({
    storage,
    document,
    getLayerNode: owner => Layer.peekNode(owner),
    report: inform,
  }));
  installNativeStubs(Layer, 'Motion.Layer');
}

// Motion.EmotePlayer is a separate C++ engine in the reference plugin. The game
// only constructs it through AffineSourceMotion when _storageType is "emote";
// the test game's `.mtn` motions use the plain Player path. Rather than silently
// claiming support, the emote gameplay surface fails loudly when exercised.
function createEmotePlayerShim(manager) {
  @nativeClass('EmotePlayer')
  class Emote {
    @nativeMethod EmotePlayer(...args) { throw new Error('Motion.EmotePlayer (E-mote engine) is not implemented by the JS engine'); }
    @nativeProperty get resourceManager() { return null; }
  }
  Emote.members.set('TimelinePlayFlagParallel', 1);
  Emote.members.set('TimelinePlayFlagDifference', 2);
  return Emote;
}
