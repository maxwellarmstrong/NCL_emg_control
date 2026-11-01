// MediaPipe's WASM loader uses importScripts, so this must be a classic worker.
importScripts('/vendor/mediapipe/vision_bundle.js');
const {HandLandmarker, FilesetResolver} = Vision;
let detector;
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') {
      const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      detector = await HandLandmarker.createFromOptions(files, {
        baseOptions: {modelAssetPath:'/models/hand_landmarker.task', delegate:'CPU'},
        runningMode:'VIDEO', numHands:2, minHandDetectionConfidence:.6,
        minHandPresenceConfidence:.6, minTrackingConfidence:.6,
      });
      self.postMessage({type:'ready'});
    } else if (data.type === 'frame' && detector) {
      try {
        const result = detector.detectForVideo(data.bitmap, data.t_ms);
        self.postMessage({type:'result', t_ms:data.t_ms, media_time_s:data.media_time_s,
          landmarks:result.landmarks, world:result.worldLandmarks, handedness:result.handedness});
      } finally { data.bitmap.close(); }
    }
  } catch (error) {
    data.bitmap?.close();
    self.postMessage({type:'error', message:String(error)});
  }
};
