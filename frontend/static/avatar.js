// avatar.js - Realtime 3D avatar with emotions, gestures, and lipsync
// Uses three.js + VRM for high-quality, low-latency avatar rendering

console.log('[Avatar] Loading three.js module...');

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from 'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@2.0.6/lib/three-vrm.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

console.log('[Avatar] three.js modules loaded successfully');

export class AvatarController {
  constructor(containerElement) {
    console.log('[Avatar] Initializing AvatarController...');
    this.container = containerElement;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.vrm = null;
    this.clock = new THREE.Clock();
    this.audioContext = null;
    this.analyser = null;
    this.currentEmotion = 'neutral';
    this.isPlaying = false;
    
    // Blendshape targets for expressions
    this.emotionPresets = {
      neutral: { happy: 0, angry: 0, sad: 0, surprised: 0, relaxed: 0 },
      happy: { happy: 1, angry: 0, sad: 0, surprised: 0, relaxed: 0 },
      surprised: { happy: 0, angry: 0, sad: 0, surprised: 1, relaxed: 0 },
      sad: { happy: 0, angry: 0, sad: 1, surprised: 0, relaxed: 0 },
      thinking: { happy: 0, angry: 0, sad: 0, surprised: 0, relaxed: 0.5 }
    };
    
    this.init();
  }

  async init() {
    try {
      console.log('[Avatar] Initializing scene...');
      
      // Setup scene
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0xf0f0f0);

      // Camera
      this.camera = new THREE.PerspectiveCamera(
        35,
        this.container.clientWidth / this.container.clientHeight,
        0.1,
        1000
      );
    this.camera.position.set(0, 1.4, 2);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.container.appendChild(this.renderer.domElement);

    // Lights
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(1, 1, 1).normalize();
    this.scene.add(light);
    
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    // Controls
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.target.set(0, 1.4, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.update();

    // Load default VRM model (fallback to simple avatar if not available)
    await this.loadAvatar();

    // Setup audio context for lipsync
    this.setupAudioAnalyser();

    // Start animation loop
    this.animate();

    // Handle window resize
    window.addEventListener('resize', () => this.onWindowResize());
    
    console.log('[Avatar] Initialization complete!');
    } catch (error) {
      console.error('[Avatar] Initialization failed:', error);
      throw error;
    }
  }

  async loadAvatar(url = null) {
    // Beautiful free models - local first to avoid CORS issues
    const defaultModels = [
      // Local models (no CORS issues!)
      'models/avatar.glb',
      'models/avatar.vrm',
      // Fallback to CDN if local not found
      'https://models.readyplayer.me/64bfa15f0e72c63d7c3934a6.glb?morphTargets=ARKit&textureAtlas=1024',
      'https://cdn.glitch.global/29e07830-2317-4b15-a044-135e73c7f840/AvatarSample_B.vrm'
    ];
    
    const urlsToTry = url ? [url, ...defaultModels] : defaultModels;
    
    for (const modelUrl of urlsToTry) {
      try {
        console.log('[Avatar] Attempting to load model from:', modelUrl);
        
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        
        // Add timeout to prevent hanging
        const gltf = await Promise.race([
          loader.loadAsync(modelUrl),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
        ]);
        
        // Check if it's a VRM model
        if (gltf.userData.vrm) {
          this.vrm = gltf.userData.vrm;
          this.scene.add(this.vrm.scene);
          
          // Adjust position and scale for VRM
          this.vrm.scene.position.y = 0;
          
          console.log('✅ VRM model loaded successfully!');
          return; // Success!
        } else {
          // Regular GLB model (Ready Player Me)
          this.scene.add(gltf.scene);
          
          // Scale and position Ready Player Me model
          gltf.scene.position.set(0, -1.6, 0);
          gltf.scene.scale.set(1.8, 1.8, 1.8);
          
          // Find and store the head bone for animations
          gltf.scene.traverse((object) => {
            if (object.isMesh && object.morphTargetInfluences) {
              this.morphTargetMesh = object;
              console.log('Found morph targets:', Object.keys(object.morphTargetDictionary || {}));
            }
          });
          
          this.readyPlayerMeModel = gltf.scene;
          console.log('✅ Ready Player Me model loaded successfully!');
          return; // Success!
        }
      } catch (error) {
        console.warn(`Failed to load model from ${modelUrl}:`, error.message);
        // Continue to next URL
      }
    }
    
    // All attempts failed, use placeholder
    console.log('[Avatar] All model loading attempts failed, using placeholder');
    this.createPlaceholderAvatar();
  }

  createPlaceholderAvatar() {
    // Create a more attractive character
    const group = new THREE.Group();
    
    // Head - skin tone
    const headGeometry = new THREE.SphereGeometry(0.18, 32, 32);
    const headMaterial = new THREE.MeshStandardMaterial({ 
      color: 0xffd4a3,
      metalness: 0.1,
      roughness: 0.8
    });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 1.5;
    head.scale.set(1, 1.1, 0.95); // Slightly elongated
    group.add(head);

    // Hair (dark brown/black)
    const hairGeometry = new THREE.SphereGeometry(0.19, 32, 32, 0, Math.PI * 2, 0, Math.PI * 0.65);
    const hairMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x1a0f0a,
      metalness: 0.3,
      roughness: 0.6
    });
    const hair = new THREE.Mesh(hairGeometry, hairMaterial);
    hair.position.y = 1.58;
    group.add(hair);

    // Eyes (larger, more expressive)
    const eyeWhiteGeometry = new THREE.SphereGeometry(0.025, 16, 16);
    const eyeWhiteMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    
    const leftEyeWhite = new THREE.Mesh(eyeWhiteGeometry, eyeWhiteMaterial);
    leftEyeWhite.position.set(-0.06, 1.53, 0.15);
    leftEyeWhite.scale.set(1.2, 1, 0.5);
    group.add(leftEyeWhite);
    
    const rightEyeWhite = leftEyeWhite.clone();
    rightEyeWhite.position.x = 0.06;
    group.add(rightEyeWhite);

    // Pupils
    const pupilGeometry = new THREE.SphereGeometry(0.015, 16, 16);
    const pupilMaterial = new THREE.MeshStandardMaterial({ color: 0x2a1810 });
    
    const leftPupil = new THREE.Mesh(pupilGeometry, pupilMaterial);
    leftPupil.position.set(-0.06, 1.53, 0.165);
    group.add(leftPupil);
    
    const rightPupil = leftPupil.clone();
    rightPupil.position.x = 0.06;
    group.add(rightPupil);

    // Eyebrows
    const eyebrowGeometry = new THREE.BoxGeometry(0.04, 0.008, 0.01);
    const eyebrowMaterial = new THREE.MeshStandardMaterial({ color: 0x1a0f0a });
    
    const leftEyebrow = new THREE.Mesh(eyebrowGeometry, eyebrowMaterial);
    leftEyebrow.position.set(-0.06, 1.58, 0.15);
    leftEyebrow.rotation.z = 0.1;
    group.add(leftEyebrow);
    
    const rightEyebrow = leftEyebrow.clone();
    rightEyebrow.position.x = 0.06;
    rightEyebrow.rotation.z = -0.1;
    group.add(rightEyebrow);

    // Nose (subtle)
    const noseGeometry = new THREE.ConeGeometry(0.015, 0.04, 8);
    const noseMaterial = new THREE.MeshStandardMaterial({ color: 0xffcf9f });
    const nose = new THREE.Mesh(noseGeometry, noseMaterial);
    nose.position.set(0, 1.47, 0.16);
    nose.rotation.x = Math.PI / 2;
    group.add(nose);

    // Mouth (more natural lips)
    const mouthGeometry = new THREE.TorusGeometry(0.035, 0.01, 16, 32, Math.PI);
    const mouthMaterial = new THREE.MeshStandardMaterial({ color: 0xff6b9d });
    this.mouth = new THREE.Mesh(mouthGeometry, mouthMaterial);
    this.mouth.position.set(0, 1.42, 0.155);
    this.mouth.rotation.x = Math.PI;
    group.add(this.mouth);

    // Neck
    const neckGeometry = new THREE.CylinderGeometry(0.08, 0.1, 0.15, 16);
    const neckMaterial = new THREE.MeshStandardMaterial({ color: 0xffd4a3 });
    const neck = new THREE.Mesh(neckGeometry, neckMaterial);
    neck.position.y = 1.32;
    group.add(neck);

    // Body (clothing - nice color)
    const bodyGeometry = new THREE.CylinderGeometry(0.15, 0.22, 0.6, 32);
    const bodyMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x8b4789, // Purple/magenta dress
      metalness: 0.2,
      roughness: 0.7
    });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 0.95;
    group.add(body);

    // Shoulders
    const shoulderGeometry = new THREE.SphereGeometry(0.09, 16, 16);
    const shoulderMaterial = new THREE.MeshStandardMaterial({ color: 0x8b4789 });
    
    const leftShoulder = new THREE.Mesh(shoulderGeometry, shoulderMaterial);
    leftShoulder.position.set(-0.18, 1.2, 0);
    group.add(leftShoulder);
    
    const rightShoulder = leftShoulder.clone();
    rightShoulder.position.x = 0.18;
    group.add(rightShoulder);

    this.scene.add(group);
    this.placeholder = { head, body, leftEye: leftPupil, rightEye: rightPupil, mouth: this.mouth, group };
  }

  setupAudioAnalyser() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
  }

  connectAudioForLipsync(audioElement) {
    if (!this.audioContext || !this.analyser) return;
    
    try {
      const source = this.audioContext.createMediaElementSource(audioElement);
      source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      this.isPlaying = true;
    } catch (error) {
      console.warn('Audio already connected or error:', error);
    }
  }

  updateLipsync() {
    if (!this.isPlaying || !this.analyser) {
      return;
    }

    this.analyser.getByteFrequencyData(this.dataArray);
    
    // Calculate average volume
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i];
    }
    const average = sum / this.dataArray.length;
    const normalized = Math.min(average / 128, 1);
    
    // Debug logging (only when there's audio)
    if (normalized > 0.05) {
      console.log(`[Lipsync] Audio detected: avg=${average.toFixed(1)}, normalized=${normalized.toFixed(2)}`);
    }

    // Apply to VRM blendshapes if available
    if (this.vrm && this.vrm.expressionManager) {
      // Map audio intensity to mouth open blendshape
      const mouthOpen = normalized * 0.8;
      this.vrm.expressionManager.setValue('aa', mouthOpen);
      this.vrm.expressionManager.update();
    } else if (this.morphTargetMesh && this.morphTargetMesh.morphTargetInfluences) {
      // Ready Player Me model with morph targets
      const dict = this.morphTargetMesh.morphTargetDictionary;
      if (dict) {
        // Try common mouth morph target names
        const mouthTargets = ['mouthOpen', 'jawOpen', 'mouth_open', 'viseme_aa'];
        for (const targetName of mouthTargets) {
          if (dict[targetName] !== undefined) {
            const idx = dict[targetName];
            this.morphTargetMesh.morphTargetInfluences[idx] = normalized * 0.6;
            
            if (normalized > 0.05) {
              console.log(`[Lipsync] Setting ${targetName}[${idx}] = ${(normalized * 0.6).toFixed(2)}`);
            }
            break;
          }
        }
      }
    } else if (this.placeholder && this.placeholder.mouth) {
      // Placeholder animation
      this.placeholder.mouth.scale.y = 0.3 + normalized * 0.4;
    }
  }

  setEmotion(emotion) {
    this.currentEmotion = emotion;
    const preset = this.emotionPresets[emotion] || this.emotionPresets.neutral;

    if (this.vrm && this.vrm.expressionManager) {
      // Smoothly transition to new emotion
      Object.keys(preset).forEach(key => {
        this.vrm.expressionManager.setValue(key, preset[key]);
      });
      this.vrm.expressionManager.update();
    } else if (this.morphTargetMesh && this.morphTargetMesh.morphTargetInfluences) {
      // Ready Player Me model with ARKit blendshapes
      const dict = this.morphTargetMesh.morphTargetDictionary;
      
      if (dict) {
        // Reset all emotion blendshapes first
        const emotionTargets = ['mouthSmile', 'mouthFrown', 'browInnerUp', 'eyeWideLeft', 'eyeWideRight'];
        emotionTargets.forEach(name => {
          if (dict[name] !== undefined) {
            this.morphTargetMesh.morphTargetInfluences[dict[name]] = 0;
          }
        });
        
        // Apply emotion-specific blendshapes
        switch(emotion) {
          case 'happy':
            if (dict['mouthSmile']) {
              this.morphTargetMesh.morphTargetInfluences[dict['mouthSmile']] = 0.7;
            }
            break;
          case 'sad':
            if (dict['mouthFrown']) {
              this.morphTargetMesh.morphTargetInfluences[dict['mouthFrown']] = 0.5;
            }
            break;
          case 'surprised':
            if (dict['eyeWideLeft']) {
              this.morphTargetMesh.morphTargetInfluences[dict['eyeWideLeft']] = 0.8;
            }
            if (dict['eyeWideRight']) {
              this.morphTargetMesh.morphTargetInfluences[dict['eyeWideRight']] = 0.8;
            }
            if (dict['mouthOpen']) {
              this.morphTargetMesh.morphTargetInfluences[dict['mouthOpen']] = 0.6;
            }
            break;
          case 'thinking':
            if (dict['browInnerUp']) {
              this.morphTargetMesh.morphTargetInfluences[dict['browInnerUp']] = 0.4;
            }
            break;
        }
      }
    } else if (this.placeholder) {
      // Animate placeholder expressions
      const { mouth, leftEye, rightEye, group } = this.placeholder;
      
      // Reset to neutral first
      if (mouth) {
        mouth.rotation.x = Math.PI;
        mouth.scale.set(1, 1, 1);
      }
      
      switch(emotion) {
        case 'happy':
          // Smile - mouth curves up
          if (mouth) {
            mouth.rotation.x = Math.PI * 1.15;
            mouth.scale.y = 1.3;
          }
          // Slightly squint eyes
          if (leftEye) leftEye.scale.y = 0.7;
          if (rightEye) rightEye.scale.y = 0.7;
          break;
          
        case 'sad':
          // Frown - mouth curves down
          if (mouth) {
            mouth.rotation.x = Math.PI * 0.85;
            mouth.scale.y = 0.8;
          }
          // Droopy eyes
          if (leftEye) leftEye.position.y = 1.52;
          if (rightEye) rightEye.position.y = 1.52;
          break;
          
        case 'surprised':
          // Wide open mouth
          if (mouth) {
            mouth.scale.set(1.5, 1.5, 1);
          }
          // Wide eyes
          if (leftEye) leftEye.scale.set(1.3, 1.3, 1);
          if (rightEye) rightEye.scale.set(1.3, 1.3, 1);
          break;
          
        case 'thinking':
          // Slightly pursed lips
          if (mouth) {
            mouth.scale.set(0.8, 0.8, 1);
          }
          // Eyes look up slightly
          if (leftEye) leftEye.position.y = 1.54;
          if (rightEye) rightEye.position.y = 1.54;
          break;
          
        default: // neutral
          // Reset positions
          if (leftEye) {
            leftEye.scale.set(1, 1, 1);
            leftEye.position.y = 1.53;
          }
          if (rightEye) {
            rightEye.scale.set(1, 1, 1);
            rightEye.position.y = 1.53;
          }
      }
    }
  }

  playGesture(gestureName) {
    // Play pre-defined gesture animation
    // In production, load gesture animations and play them here
    console.log('Playing gesture:', gestureName);
    
    if (this.vrm && this.vrm.humanoid) {
      // Example: wave hand
      if (gestureName === 'wave') {
        const rightHand = this.vrm.humanoid.getNormalizedBoneNode('rightHand');
        if (rightHand) {
          // Simple wave animation (in production, use proper animation system)
          const originalRotation = rightHand.rotation.clone();
          const waveAnimation = () => {
            rightHand.rotation.z = originalRotation.z + Math.sin(Date.now() * 0.01) * 0.5;
          };
          
          const duration = 2000;
          const startTime = Date.now();
          const animate = () => {
            if (Date.now() - startTime < duration) {
              waveAnimation();
              requestAnimationFrame(animate);
            } else {
              rightHand.rotation.copy(originalRotation);
            }
          };
          animate();
        }
      }
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const deltaTime = this.clock.getDelta();

    // Update lipsync
    this.updateLipsync();

    // Update VRM if loaded
    if (this.vrm) {
      this.vrm.update(deltaTime);
    }

    this.renderer.render(this.scene, this.camera);
  }

  onWindowResize() {
    this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  // Public API for controlling avatar
  speak(audioUrl, emotion = 'neutral', gesture = null) {
    this.setEmotion(emotion);
    
    if (gesture) {
      this.playGesture(gesture);
    }

    // Play audio and sync lips
    const audio = new Audio(audioUrl);
    this.connectAudioForLipsync(audio);
    
    audio.onended = () => {
      this.isPlaying = false;
      this.setEmotion('neutral');
    };
    
    audio.play().catch(err => console.error('Audio play error:', err));
  }

  destroy() {
    if (this.renderer) {
      this.renderer.dispose();
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

// Helper function to create avatar from photo (future enhancement)
export async function generateAvatarFromPhoto(photoUrl) {
  // Placeholder for future integration with avatar generation APIs
  // Could use Ready Player Me API, or ML-based face-to-3D services
  console.log('Avatar generation from photo:', photoUrl);
  return null; // Returns VRM URL when implemented
}
