const API_BASE = "http://localhost:8001";

// Use simple polling mode - more stable, no constant recording
const USE_WEBSOCKET_STREAM = false;
const USE_WEBRTC_OPUS = false;  // Disabled - causes too many false triggers
let wsStream = null;
let pc = null; // WebRTC PeerConnection
let audioCtx = null; // AudioContext for lipsync
let mainLoopStarted = false; // Prevent multiple mainLoop starts

let mediaRecorder = null;
let chunks = [];
let isRecording = false;
let busy = false;
let avatarController = null; // 3D Avatar controller
let audioSourceNode = null; // Reuse audio source for lip-sync
let isPlayingAudio = false;
let currentPhase = 'idle'; // idle | listening | processing | answering
let isMuted = false;

const IDLE_TEXT = "Күту режимі";
const LISTENING_TEXT = "Тыңдап тұрмын...";
const PROCESS_TEXT = "Өңдеп жатырмын...";
const ANSWER_TEXT = "Жауап беріп жатырмын...";

// Format text into lines without breaking words
function formatSubtitle(text, maxCharsPerLine = 44) {
  const words = (text || '').trim().split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    if (!current.length) {
      current = w;
      continue;
    }
    if ((current + ' ' + w).length <= maxCharsPerLine) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length) lines.push(current);
  // cap to 3 lines for readability
  return lines.slice(0, 3);
}

// Render a single role-labeled subtitle line (with wrapping)
function renderSubtitleLine(container, roleKey, roleLabel, text) {
  const lines = formatSubtitle(text);
  const roleClass = roleKey === 'visitor' ? 'visitor' : 'assistant';
  let html = '';
  if (lines.length > 0) {
    html += `<span class="subtitle-line"><span class="subtitle-role ${roleClass}">${roleLabel}:</span><span class="subtitle-text">${escapeHtml(lines[0])}</span></span>`;
    for (let i = 1; i < lines.length; i++) {
      html += `<span class="subtitle-line"><span class="subtitle-text">${escapeHtml(lines[i])}</span></span>`;
    }
  }
  container.innerHTML = html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Extract routing info from free text using simple regexes
function parseRouting(text) {
  if (!text) return null;
  const deptMatch = text.match(/отдел(?:а|у|\s+)?\s*([А-ЯA-Z][а-яa-zA-Z\-\s]+)/i);
  const roomMatch = text.match(/кабинет\s*(\d{1,4}[A-Za-zА-Я]?)|комната\s*(\d{1,4})/i);
  const floorMatch = text.match(/(первый|второй|третий|четвертый|пятый|\d+\s*этаж)/i);
  const contactMatch = text.match(/контакт(?:ы|)\s*:?[\s\-]*([\w\s@.+-]{3,})/i);
  const department = deptMatch ? deptMatch[1].trim() : '';
  const room = roomMatch ? (roomMatch[1] || roomMatch[2] || '').trim() : '';
  const floor = floorMatch ? floorMatch[1].trim() : '';
  const contact = contactMatch ? contactMatch[1].trim() : '';
  if (department || room || floor || contact) {
    return { department, room, floor, contact };
  }
  return null;
}

async function recordChunk(durationMs) {
  return new Promise(async (resolve, reject) => {
    try {
      if (isRecording) return reject("already recording");
      isRecording = true;
      chunks = [];

      const constraints = {
        audio: true,
        video: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      animateMicBars(true);

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        isRecording = false;
        animateMicBars(false);
        resolve(blob);
      };

      mediaRecorder.start();
      setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      }, durationMs);
    } catch (e) {
      isRecording = false;
      reject(e);
    }
  });
}

async function checkAudioVolume(blob) {
  // Check if audio has sufficient volume before sending to Whisper
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Calculate RMS (Root Mean Square) of audio
    const channelData = audioBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) {
      sum += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sum / channelData.length);
    
    console.log(`[Audio Check] RMS volume: ${rms.toFixed(4)}`);
    
    // Threshold: 0.005 is very quiet, 0.01 is normal speech, 0.05 is loud
    if (rms < 0.008) {
      console.log('[Audio Check] ❌ Audio too quiet, skipping Whisper');
      return false;
    }
    
    console.log('[Audio Check] ✅ Audio loud enough, sending to Whisper');
    return true;
  } catch (e) {
    console.error('[Audio Check] Error checking volume:', e);
    return true; // If check fails, send anyway
  }
}

async function sendAudioToBackend(blob) {
  const formData = new FormData();
  formData.append("audio", blob, "recording.webm");

  const res = await fetch(`${API_BASE}/api/dialogue`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  return data;
}

// Smooth video crossfade between waiting and speaking
function switchToSpeaking() {
  const waitingVideo = document.getElementById("waitingVideo");
  const speakingVideo = document.getElementById("speakingVideo");
  
  console.log('[Video] Switching to speaking mode');
  
  // Fade out waiting, fade in speaking
  waitingVideo.style.opacity = "0";
  speakingVideo.style.opacity = "1";
  
  // Start speaking video
  speakingVideo.currentTime = 0;
  speakingVideo.play().catch(e => console.warn('[Video] Speaking play error:', e));
}

function switchToWaiting() {
  const waitingVideo = document.getElementById("waitingVideo");
  const speakingVideo = document.getElementById("speakingVideo");
  
  console.log('[Video] Switching back to waiting mode');
  
  // Fade in waiting, fade out speaking
  speakingVideo.style.opacity = "0";
  waitingVideo.style.opacity = "1";
  
  // Pause speaking video to save resources
  speakingVideo.pause();
}

async function loopOnce() {
  if (busy) return;
  busy = true;
  currentPhase = 'listening';

  try {
    console.log('[Loop] Listening...');

    const audioBlob = await recordChunk(6000);
    
    // Check audio volume BEFORE sending to Whisper
    const hasAudio = await checkAudioVolume(audioBlob);
    if (!hasAudio) {
      console.log('[Loop] Skipping - no audio detected');
      busy = false;
      return;
    }
    
    console.log('[Loop] Processing...');
    currentPhase = 'processing';

    const data = await sendAudioToBackend(audioBlob);

    console.log('[Loop] User:', data.user_text);
    console.log('[Loop] Answer:', data.answer_text);

    // Render subtitles: show user question briefly, then assistant answer
    const subsEl = document.getElementById('subtitles');
    const routePanel = document.getElementById('routePanel');
    const routeDept = document.getElementById('routeDept');
    const routeRoom = document.getElementById('routeRoom');
    const routeFloor = document.getElementById('routeFloor');
    const routeContact = document.getElementById('routeContact');
    if (subsEl) {
      const userTextRaw = data.user_text || '';
      const answerTextRaw = data.answer_text || '';

      // Reset any lingering inline styles/classes and fade in
      subsEl.style.display = '';
      subsEl.className = 'subtitles visible';

      // Show visitor line first (if exists)
      if (userTextRaw) {
        renderSubtitleLine(subsEl, 'visitor', 'Посетитель', userTextRaw);
      }

      // Then replace with assistant line
      if (answerTextRaw) {
        const delayMs = userTextRaw ? 1200 : 0;
        setTimeout(() => {
          renderSubtitleLine(subsEl, 'assistant', 'Консультант', answerTextRaw);
        }, delayMs);
      }
    }

    const audioUrl = data.audio_url;

    // Try to parse routing info from answer text (simple heuristics)
    const answerText = (data.answer_text || '').trim();
    const routing = parseRouting(answerText);
    if (routing && routePanel) {
      routeDept.textContent = routing.department ? `Отдел: ${routing.department}` : '';
      routeRoom.textContent = routing.room ? `Кабинет: ${routing.room}` : '';
      routeFloor.textContent = routing.floor ? `Этаж: ${routing.floor}` : '';
      routeContact.textContent = routing.contact ? `Контакт: ${routing.contact}` : '';
      routePanel.style.display = 'block';
    } else if (routePanel) {
      routePanel.style.display = 'none';
    }

    if (audioUrl) {
          const answerText = (data.answer_text || '').trim();
          const routing = data.routing && (data.routing.department || data.routing.room || data.routing.floor || data.routing.contact)
            ? data.routing : parseRouting(answerText);
      // Switch to speaking video BEFORE playing audio
      switchToSpeaking();
      
      const audioEl = document.getElementById("replyAudio");
      const fullUrl = API_BASE + audioUrl;
      audioEl.src = fullUrl;
      if (isMuted) audioEl.muted = true;
      const volSlider = document.getElementById('volumeSlider');
      if (volSlider) audioEl.volume = parseFloat(volSlider.value || '1');
      audioEl.volume = 1.0;
      
      console.log('[Audio] Playing response:', fullUrl);
      
      try {
        isPlayingAudio = true;
        currentPhase = 'answering';
        await audioEl.play();
        console.log('[Audio] 🔊 Playing response');
      } catch (e) {
        console.error("Audio play error:", e);
        showToast('Ошибка воспроизведения ответа', 'error');
      }
      
      // Wait for audio to finish
      await new Promise((resolve) => {
        audioEl.onended = () => {
          console.log('[Audio] Response finished');
          isPlayingAudio = false;
          currentPhase = 'idle';
          resolve();
        };
        // Safety timeout
        setTimeout(() => { isPlayingAudio = false; currentPhase = 'idle'; resolve(); }, 30000);
      });
      
      // Switch back to waiting video after response
      switchToWaiting();

      // Hide subtitles after finishing response to return to idle clean look
      if (subsEl) {
        setTimeout(() => {
          subsEl.className = 'subtitles hidden';
          subsEl.innerHTML = '';
        }, 600);
      }
      // Auto-hide route panel after some time to return to idle
      if (routePanel) {
        setTimeout(() => { routePanel.style.display = 'none'; }, 15000);
      }
    }
  } catch (e) {
    console.error("loopOnce error", e);
    showToast('Ошибка обработки диалога', 'error');
  } finally {
    console.log('[Loop] Idle, ready for next interaction');
    currentPhase = 'idle';
    busy = false;
  }
}

// UI helpers
function setStatus(statusKey, labelText) {
  const indicator = document.getElementById('statusIndicator');
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  if (!indicator || !dot || !label) return;
  indicator.classList.remove('status-idle','status-listening','status-processing','status-answering','status-noface');
  indicator.classList.add(`status-${statusKey}`);
  label.textContent = labelText;
}

function updateStatusFromState() {
  if (typeof presenceDetected !== 'undefined' && !presenceDetected) {
    setStatus('noface', 'Нет лица — микрофон выключен');
    return;
  }
  if (currentPhase === 'answering' || isPlayingAudio) {
    setStatus('answering', 'Отвечаю');
  } else if (currentPhase === 'processing') {
    setStatus('processing', 'Думаю');
  } else if (currentPhase === 'listening') {
    setStatus('listening', 'Слушаю');
  } else {
    setStatus('idle', 'Готов');
  }
}

function wireAudioControls() {
  const muteBtn = document.getElementById('muteBtn');
  const volSlider = document.getElementById('volumeSlider');
  const audioEl = document.getElementById('replyAudio');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      isMuted = !isMuted;
      if (audioEl) audioEl.muted = isMuted;
      muteBtn.textContent = isMuted ? '🔈' : '🔇';
    });
  }
  if (volSlider) {
    volSlider.addEventListener('input', () => {
      const v = parseFloat(volSlider.value || '1');
      if (audioEl) audioEl.volume = v;
    });
  }
}

function setupOnboarding() {
  const card = document.getElementById('onboardCard');
  const dismiss = document.getElementById('onboardDismiss');
  if (!card) return;
  const seen = localStorage.getItem('onboardSeen');
  if (seen === '1') {
    card.classList.add('hidden');
  }
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      card.classList.add('hidden');
      localStorage.setItem('onboardSeen', '1');
    });
  }
}

// Hint text (static)
const hints = ['Скажите: "Где находится бухгалтерия?"'];

function showToast(text, type = 'info', ttlMs = 3200) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="dot"></span><div class="text">${escapeHtml(text)}</div><button class="toast-retry">Повторить</button>`;
  stack.appendChild(toast);

  const retryBtn = toast.querySelector('.toast-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      toast.remove();
      // Trigger a retry of main loop once
      if (!busy) {
        loopOnce().catch(() => {});
      }
    });
  }

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(4px)';
    setTimeout(() => toast.remove(), 220);
  }, ttlMs);
}

function animateMicBars(active) {
  const indicator = document.getElementById('micIndicator');
  if (!indicator) return;
  if (active) {
    indicator.classList.add('active');
    indicator.setAttribute('aria-hidden', 'false');
  } else {
    indicator.classList.remove('active');
    indicator.setAttribute('aria-hidden', 'true');
  }
}

async function mainLoop() {
  if (mainLoopStarted) {
    console.log('[MainLoop] Already started, ignoring duplicate call');
    return;
  }
  mainLoopStarted = true;

  // Kick off status updater loop
  setInterval(updateStatusFromState, 400);

  wireAudioControls();
  setupOnboarding();
  
  console.log('[MainLoop] Starting main loop...');

  if (USE_WEBRTC_OPUS) {
    console.log('[MainLoop] Using WebRTC Opus mode');
    try {
      await startWebRTCOpusLoop();
    } catch (e) {
      console.error("WebRTC Opus start error", e);
    }
  } else if (USE_WEBSOCKET_STREAM) {
    console.log('[MainLoop] Using WebSocket streaming mode');
    try {
      await startWebSocketStreaming();
    } catch (e) {
      console.error("WebSocket stream start error", e);
      // fallback to original polling loop
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        if (presenceDetected) {
          await loopOnce();
        }
      }
    }
    return;
  }

  // Prepare microphone access (will only record when face+attention detected)
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log('[MainLoop] ✅ Microphone access granted');
  } catch (e) {
    console.error('[MainLoop] ❌ No mic access:', e);
  }

  // MOTION-ACTIVATED MODE: Record only when movement detected
  console.log('[MainLoop] 🎤 Presence-gated mode: records only when a person is detected');
  
  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    if (presenceDetected && currentPhase === 'idle') {
      if (!window.__greetedRecently) {
        window.__greetedRecently = true;
        try {
          console.log('[Greeting] Auto-start greeting');
          await loopOnce();
        } finally {
          setTimeout(() => { window.__greetedRecently = false; }, 20000);
        }
      } else {
        await loopOnce();
      }
    } else {
      // Skip recording when no person is detected
      // Keep loop lightweight
    }
  }
}

// New WebRTC Opus loop function
async function startWebRTCOpusLoop() {
  console.log('[WebRTC] Initializing WebRTC with Opus codec...');
  
  // Get microphone access
  const stream = await navigator.mediaDevices.getUserMedia({ 
    audio: { 
      echoCancellation: true, 
      noiseSuppression: true, 
      autoGainControl: true,
      sampleRate: 16000,
      channelCount: 1
    },
    video: false 
  });
  
  console.log('[WebRTC] Microphone access granted');
  
  // Connect to WebSocket on backend server
  const wsUrl = `ws://localhost:8000/api/webrtc/audio`;
  const ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('[WebRTC] WebSocket connected');
  };
  
  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    console.log('[WebRTC] Server response:', data);
    
    if (data.status === 'complete') {
      console.log(`[WebRTC] Got response: ${data.answer_text}`);
      
      // Display in dialogue log
      const log = document.getElementById("dialogueLog");
      if (data.user_text) {
        const userDiv = document.createElement("div");
        userDiv.className = "message";
        userDiv.innerHTML = `<span class="role">Қонақ:</span> ${data.user_text}`;
        log.appendChild(userDiv);
      }
      if (data.answer_text) {
        const botDiv = document.createElement("div");
        botDiv.className = "message";
        botDiv.innerHTML = `<span class="role">Ресепшен:</span> ${data.answer_text}`;
        log.appendChild(botDiv);
      }
      log.scrollTop = log.scrollHeight;
      
      // Play audio with lip-sync
      if (data.audio_url) {
        const audioEl = document.getElementById("replyAudio");
        const fullUrl = API_BASE + data.audio_url;
        audioEl.src = fullUrl;
        
        // Connect to avatar analyser for lip-sync
        if (avatarController && avatarController.analyser && avatarController.audioContext) {
          try {
            if (avatarController.audioContext.state === 'suspended') {
              await avatarController.audioContext.resume();
            }
            
            // Create source only once, reuse if already exists
            if (!audioSourceNode) {
              audioSourceNode = avatarController.audioContext.createMediaElementSource(audioEl);
              audioSourceNode.connect(avatarController.analyser);
              avatarController.analyser.connect(avatarController.audioContext.destination);
              console.log('[WebRTC] Audio source created and connected to analyser');
            } else {
              console.log('[WebRTC] Reusing existing audio source');
            }
            
            audioEl.onplay = () => {
              avatarController.isPlaying = true;
              console.log('[WebRTC] Audio playing, lip-sync active');
            };
            
            audioEl.onended = () => {
              avatarController.isPlaying = false;
              console.log('[WebRTC] Audio ended');
            };
            
            audioEl.onpause = () => {
              avatarController.isPlaying = false;
            };
          } catch (e) {
            console.warn('[WebRTC] Analyser connection failed:', e);
          }
        }
        
        try {
          await audioEl.play();
        } catch (e) {
          console.error('[WebRTC] Audio play error:', e);
        }
      }
    } else if (data.status === 'error') {
      console.error('[WebRTC] Error:', data.message);
    }
  };
  
  ws.onerror = (error) => {
    console.error('[WebRTC] WebSocket error:', error);
  };
  
  ws.onclose = () => {
    console.log('[WebRTC] WebSocket closed');
  };
  
  // Use MediaRecorder to encode to Opus
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 16000
  });
  
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
      console.log(`[WebRTC] Sending ${event.data.size} bytes`);
      ws.send(event.data);
    }
  };
  
  mediaRecorder.start(100); // Send chunks every 100ms
  
  console.log('[WebRTC] Recording started');
}


async function startWebRTCSession() {
  if (pc) return;

  pc = new RTCPeerConnection();

  pc.ontrack = (event) => {
    console.log('pc.ontrack', event);
    const audioEl = document.getElementById('replyAudio');
    // attach incoming stream to existing audio element
    audioEl.srcObject = event.streams[0];
    audioEl.autoplay = true;
    audioEl.play().catch((e) => console.warn('play error', e));
  };

  // get local audio and add as track
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  for (const track of stream.getAudioTracks()) {
    pc.addTrack(track, stream);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(`${API_BASE}/webrtc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type }),
  });

  const data = await res.json();
  if (data && data.sdp) {
    const answer = { sdp: data.sdp, type: data.type };
    await pc.setRemoteDescription(answer);
    console.log('WebRTC connected, pc_id=', data.pc_id);
  } else {
    throw new Error('No SDP in response');
  }
}


async function startWebSocketStreaming() {
  if (wsStream) return;

  const statusEl = document.getElementById("recordStatus");
  statusEl.textContent = LISTENING_TEXT;

  // Try IPv4 localhost candidates only to avoid IPv6 / binding issues on Windows
  const candidates = ['127.0.0.1', 'localhost'];
  let connected = false;
  let lastError = null;
  for (const host of candidates) {
    try {
      const url = `ws://${host}:8000/ws/stream`;
      console.log('Attempting WebSocket to', url);
      wsStream = new WebSocket(url);
      wsStream.binaryType = 'arraybuffer';

      // wait for open or error for a short time
      const ok = await new Promise((resolve) => {
        const to = setTimeout(() => resolve(false), 1200);
        wsStream.onopen = () => { clearTimeout(to); resolve(true); };
        wsStream.onerror = (e) => { clearTimeout(to); resolve(false); };
      });

      if (ok) {
        connected = true;
        console.log('✅ WebSocket connected to', url);
        break;
      } else {
        lastError = 'connect failed to ' + url;
        try { wsStream.close(); } catch (e) {}
        wsStream = null;
      }
    } catch (e) {
      lastError = e;
      wsStream = null;
    }
  }

  if (!connected) {
    console.warn('WebSocket connect failed to all candidates:', lastError);
    // fallback to polling loop to keep basic functionality working
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      if (presenceDetected) {
        await loopOnce();
      }
    }
  }

  // WebSocket is now connected, set up handlers
  console.log('[WebSocket] Setting up message handlers...');
  wsStream.binaryType = 'arraybuffer';

  // Start media recording immediately since WebSocket is already open
  console.log('[Mic] Requesting microphone access...');
  const stream = await navigator.mediaDevices.getUserMedia({ 
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, 
    video: false 
  });
  console.log('[Mic] ✅ Microphone access granted');

  // Set up an analyser to compute RMS and only start MediaRecorder when audio is above threshold
  const audioCtxLocal = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtxLocal.createMediaStreamSource(stream);
  const analyser = audioCtxLocal.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const bufferLen = analyser.fftSize;
  const dataArr = new Float32Array(bufferLen);

  // configuration: tune these values if system triggers too easily
  const RMS_THRESHOLD = 0.02; // try 0.02..0.06 depending on mic sensitivity
  const REQUIRED_FRAMES = 3; // need several consecutive frames above threshold
  let consecutive = 0;

  // helper that samples analyser and returns current RMS
  function sampleRms() {
    analyser.getFloatTimeDomainData(dataArr);
    let sum = 0;
    for (let i = 0; i < dataArr.length; i++) sum += dataArr[i] * dataArr[i];
    const rms = Math.sqrt(sum / dataArr.length);
    return rms;
  }

  // Wait until RMS stays above threshold for REQUIRED_FRAMES
  console.log('[Mic] Waiting for audio input...');
  await new Promise((resolve) => {
    const check = () => {
      const rms = sampleRms();

      if (rms >= RMS_THRESHOLD) {
        consecutive += 1;
        if (consecutive === 1) console.log(`[Mic] Audio detected! RMS=${rms.toFixed(4)}, waiting for ${REQUIRED_FRAMES} frames...`);
      } else {
        consecutive = 0;
      }
      if (consecutive >= REQUIRED_FRAMES) {
        console.log(`[Mic] Audio threshold reached! Starting recording...`);
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });

  // Now start MediaRecorder and streaming chunks
  console.log('[Mic] Starting MediaRecorder...');
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0 && wsStream && wsStream.readyState === WebSocket.OPEN) {
      console.log(`[Mic] Sending ${e.data.size} bytes to server`);
      e.data.arrayBuffer().then((buf) => wsStream.send(buf));
    }
  };

  recorder.start(120); // send every 120ms to reduce latency

  // Audio playback context for PCM chunks
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let currentAudioSampleRate = 16000;

  wsStream.onmessage = async (evt) => {
      try {
        if (typeof evt.data === 'string') {
          const obj = JSON.parse(evt.data);
          if (obj.type === 'user_text') {
            const log = document.getElementById('dialogueLog');
            const userDiv = document.createElement('div');
            userDiv.className = 'message';
            userDiv.innerHTML = `<span class="role">Гость:</span> ${obj.text}`;
            log.appendChild(userDiv);
            log.scrollTop = log.scrollHeight;
          } else if (obj.type === 'answer') {
            const log = document.getElementById('dialogueLog');
            const botDiv = document.createElement('div');
            botDiv.className = 'message';
            botDiv.innerHTML = `<span class="role">Ресепшен:</span> ${obj.text}`;
            log.appendChild(botDiv);
            log.scrollTop = log.scrollHeight;
            
            // Handle avatar emotion/gesture from backend metadata
            if (avatarController) {
              if (obj.emotion) {
                avatarController.setEmotion(obj.emotion);
              }
              if (obj.gesture) {
                avatarController.playGesture(obj.gesture);
              }
            }
          } else if (obj.type === 'audio_start') {
            currentAudioSampleRate = obj.sampleRate || 16000;
            console.log(`[Audio] Starting audio stream, sampleRate=${currentAudioSampleRate}`);
            
            // Initialize AudioContext if not already done
            if (!audioCtx) {
              audioCtx = new (window.AudioContext || window.webkitAudioContext)();
              console.log('[Audio] Created new AudioContext');
            }
            
            // Resume if suspended
            if (audioCtx.state === 'suspended') {
              await audioCtx.resume();
              console.log('[Audio] AudioContext resumed');
            }
            
            // Set avatar to speaking state
            if (avatarController && obj.emotion) {
              avatarController.setEmotion(obj.emotion);
            } else if (avatarController) {
              avatarController.setEmotion('happy');
            }
          } else if (obj.type === 'audio_end') {
            console.log('[Audio] Audio stream ended');
            // Reset avatar to neutral
            if (avatarController) {
              avatarController.setEmotion('neutral');
            }
          }
        } else {
          // binary PCM chunk (Int16LE)
          const arrayBuffer = await evt.data.arrayBuffer();
          playPcmChunk(arrayBuffer, currentAudioSampleRate, audioCtx).catch(e => console.error('play chunk', e));
        }
      } catch (e) {
        console.error('ws message parse', e);
      }
    };

  wsStream.onclose = () => {
    console.log('ws closed');
    recorder.stop();
    stream.getTracks().forEach(t => t.stop());
    wsStream = null;
    statusEl.textContent = IDLE_TEXT;
  };
}

document.addEventListener("DOMContentLoaded", async () => {
  console.log('[Init] Loading config and starting presence detection...');
  try {
    const res = await fetch('http://localhost:8000/api/config');
    const cfg = await res.json();
    window.__presenceCfg = cfg.presence || {};
    console.log('[Init] Presence config loaded:', window.__presenceCfg);
  } catch (e) {
    console.warn('[Init] Config load failed, using defaults');
    window.__presenceCfg = {};
  }
  // Start presence detection (camera) and main loop
  startPresenceDetection();
  // wire up optional WebRTC button for low-latency testing
  const webrtcBtn = document.getElementById('webrtcBtn');
  if (webrtcBtn) {
    webrtcBtn.addEventListener('click', async () => {
      try {
        await startWebRTCSession();
        webrtcBtn.disabled = true;
        webrtcBtn.textContent = 'WebRTC active';
      } catch (e) {
        console.error('WebRTC start error', e);
        alert('WebRTC start failed: ' + e.message);
      }
    });
  }
});


// Presence detection: use video feed to detect motion and wake the system
let presenceTimer = null;
let presenceDetected = false;
async function startPresenceDetection() {
  console.log('[Presence] Starting presence detection...');
  const presenceVideo = document.createElement('video');
  presenceVideo.autoplay = true;
  presenceVideo.muted = true;
  presenceVideo.playsInline = true;
  // Keep video active but invisible
  presenceVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;';
  document.body.appendChild(presenceVideo);

  try {
    console.log('[Presence] Requesting camera access...');
    // Prefer front/user-facing camera by label or default
    let videoDeviceId = undefined;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      // Heuristics: pick label containing 'User Facing' or the first videoinput
      const preferred = videoInputs.find(d => /user facing|front|integrated/i.test(d.label)) || videoInputs[0];
      if (preferred) {
        videoDeviceId = preferred.deviceId;
        console.log('[Presence] Using camera:', preferred.label || preferred.deviceId);
      } else {
        console.warn('[Presence] No videoinput devices found, falling back to default constraints');
      }
    } catch (e) {
      console.warn('[Presence] enumerateDevices failed, proceeding with default camera');
    }

    // Request video only for presence detection
    const constraints = {
      video: videoDeviceId ? { deviceId: { exact: videoDeviceId }, width: 320, height: 240 } : { width: 320, height: 240 },
      audio: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    presenceVideo.srcObject = stream;
    // Debug video disabled (kept hidden)
    console.log('[Presence] Got camera access');
  } catch (e) {
    console.warn('[Presence] Cannot access camera/microphone:', e);
    // fallback to immediate start
    console.log('[Presence] Fallback: starting mainLoop without presence detection');
    mainLoop();
    return;
  }

  // Start mainLoop to initialize microphone, but it will only record when person detected
  console.log('[Presence] ⏳ Waiting for person to approach...');
  console.log('[Presence] Starting mainLoop (microphone will activate only when face detected)');
  mainLoop();
  
  // Use MediaPipe Face Mesh for accurate distance detection
  console.log('[Presence] 🔄 Loading MediaPipe Face Mesh (Google technology)...');
  
  const faceMesh = new FaceMesh({
    locateFile: (file) => {
      return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`;
    }
  });
  
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  // Debug overlay canvas disabled for kiosk mode
  const overlay = null;
  let ctx = null;
  
  console.log('[Presence] ✅ MediaPipe Face Mesh initialized!');
  
  // Advanced presence: distance tiers + attention detection
  let detectionCount = 0;
  let lastTier = 'far';
  let attention = false;
  faceMesh.onResults((results) => {
    try {
      detectionCount++;
      
      if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];

        // Inter-Pupillary Distance (IPD) normalized by frame width
        const leftEye = landmarks[33];
        const rightEye = landmarks[263];
        const dx = (rightEye.x - leftEye.x) * presenceVideo.videoWidth;
        const dy = (rightEye.y - leftEye.y) * presenceVideo.videoHeight;
        const eyeDistancePixels = Math.sqrt(dx * dx + dy * dy);
        const eyeDistanceNorm = eyeDistancePixels / presenceVideo.videoWidth; // 0..1
// Draw overlay (hidden but working)
        try {
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          ctx.save();
          ctx.scale(overlay.width / presenceVideo.videoWidth, overlay.height / presenceVideo.videoHeight);
          // draw eyes and nose points
          ctx.fillStyle = '#00e5ff';
          ctx.beginPath();
          ctx.arc(leftEye.x * presenceVideo.videoWidth, leftEye.y * presenceVideo.videoHeight, 4, 0, Math.PI * 2);
          ctx.arc(rightEye.x * presenceVideo.videoWidth, rightEye.y * presenceVideo.videoHeight, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = attention ? '#4CAF50' : '#FFC107';
          ctx.beginPath();
          ctx.arc(nose.x * presenceVideo.videoWidth, nose.y * presenceVideo.videoHeight, 4, 0, Math.PI * 2);
          ctx.fill();
          // draw line between eyes
          ctx.strokeStyle = '#90CAF9';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(leftEye.x * presenceVideo.videoWidth, leftEye.y * presenceVideo.videoHeight);
          ctx.lineTo(rightEye.x * presenceVideo.videoWidth, rightEye.y * presenceVideo.videoHeight);
          ctx.stroke();
          ctx.restore();
          // text metrics
          ctx.fillStyle = '#fff';
          ctx.font = '12px Segoe UI, Arial';
          ctx.fillText(`IPD: ${eyeDistancePixels.toFixed(0)} px`, 8, 18);
          ctx.fillText(`norm: ${eyeDistanceNorm.toFixed(3)}`, 8, 34);
          ctx.fillText(`tier: ${tier}`, 8, 50);
          ctx.fillText(`attention: ${attention ? 'yes' : 'no'} (${horizOffset.toFixed(0)}, ${vertOffset.toFixed(0)})`, 8, 66);
        } catch (e) {
          // ignore overlay errors
        }

        
        // Distance tiers (configurable thresholds)
        const pcfg = window.__presenceCfg || {};
        const nearTh = pcfg.nearThreshold ?? 0.10;
        const medTh = pcfg.mediumThreshold ?? 0.07;
        let tier = 'far';
        if (eyeDistanceNorm >= nearTh) tier = 'near';
        else if (eyeDistanceNorm >= medTh) tier = 'medium';

        // Head attention: use nose tip vs eyes to estimate facing forward
        const nose = landmarks[1];
        const noseToMidEyeX = ((leftEye.x + rightEye.x) / 2) - nose.x;
        const noseToMidEyeY = ((leftEye.y + rightEye.y) / 2) - nose.y;
        const horizOffset = Math.abs(noseToMidEyeX) * presenceVideo.videoWidth;
        const vertOffset = Math.abs(noseToMidEyeY) * presenceVideo.videoHeight;
        const tol = (pcfg.attentionTolerancePx ?? 80);
        attention = horizOffset < tol && vertOffset < tol;

        if (tier !== lastTier) {
          lastTier = tier;
          console.log(`[Presence] Distance tier → ${tier} (norm=${eyeDistanceNorm.toFixed(3)})`);
        }

        // Apply ROI (region of interest) from config to filter detections
        const roi = pcfg.roi || { top: 0, left: 0, width: 1, height: 1 };
        const xMin = roi.left;
        const xMax = roi.left + roi.width;
        const yMin = roi.top;
        const yMax = roi.top + roi.height;
        const noseXNorm = nose.x; // normalized 0..1
        const noseYNorm = nose.y;
        const inRoi = noseXNorm >= xMin && noseXNorm <= xMax && noseYNorm >= yMin && noseYNorm <= yMax;

        // Person detected with good conditions: near/medium tier + attention + ROI
        if ((tier === 'near' || tier === 'medium') && attention && inRoi) {
          if (!presenceDetected) {
            presenceDetected = true;
            console.log('[Presence] ✅ Person detected with attention, mic ON');
          }
          // Reset timer
          if (presenceTimer) clearTimeout(presenceTimer);
          const holdMs = pcfg.holdMs ?? 20000;
          presenceTimer = setTimeout(() => {
            presenceDetected = false;
            console.log('[Presence] ❌ Person left or attention lost, mic OFF');
          }, holdMs);
        } else {
          // Log hints occasionally
          if (detectionCount % 60 === 0) {
            const tip = tier === 'far' ? 'Подойдите ближе' : (attention ? '' : 'Посмотрите на экран');
            if (tip) console.log(`[Presence] Hint: ${tip} (tier=${tier}, attention=${attention})`);
          }
          // Hide subtitles when attention/near conditions are not met (leaving area)
          const subsEl = document.getElementById('subtitles');
          if (subsEl) subsEl.style.display = 'none';
        }
      } else {
        // No face detected
        if (detectionCount % 90 === 0) {
          console.log('[Presence] No face detected - waiting...');
        }
        // Ensure subtitles are hidden in idle when no face
        const subsEl = document.getElementById('subtitles');
        if (subsEl) { subsEl.style.display = 'none'; subsEl.innerText = ''; }
      }
    } catch (e) {
      console.warn('[Presence] Detection error:', e);
    }
  });
  
  // Manual camera loop (without Camera utility)
  console.log('[Presence] 📹 Starting camera loop for MediaPipe...');
  
  async function detectFaces() {
    if (presenceVideo.readyState === presenceVideo.HAVE_ENOUGH_DATA) {
      await faceMesh.send({image: presenceVideo});
    }
    requestAnimationFrame(detectFaces);
  }
  
  presenceVideo.onloadedmetadata = () => {
    console.log('[Presence] ✅ Camera ready! Starting face detection...');
    detectFaces();
  };
}

// Helper function to send greeting
async function sendGreeting() {
  try {
    const statusEl = document.getElementById('recordStatus');
    statusEl.textContent = '⏳ Дайындап жатырмын...';
    
    console.log('[Greeting] Requesting automatic greeting from server...');
    const response = await fetch(`${API_BASE}/api/dialogue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_text: 'Сәлеметсіз бе' })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('[Greeting] Got greeting response:', data);
      
      // Display greeting text
      const log = document.getElementById('dialogueLog');
      const botDiv = document.createElement('div');
      botDiv.className = 'message';
      botDiv.innerHTML = `<span class="role">Ресепшен:</span> ${data.bot_text}`;
      log.appendChild(botDiv);
      log.scrollTop = log.scrollHeight;
      
      // Play greeting audio
      if (data.audio_path) {
        const audioEl = document.getElementById('replyAudio');
        const fullUrl = API_BASE + data.audio_path;
        audioEl.src = fullUrl;
        audioEl.volume = 1.0;
        
        console.log('[Greeting] 🔊 Playing greeting audio:', fullUrl);
        
        // Set up lip-sync
        if (avatarController && avatarController.analyser && avatarController.audioContext) {
          fetch(fullUrl)
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => avatarController.audioContext.decodeAudioData(arrayBuffer))
            .then(audioBuffer => {
              const source = avatarController.audioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(avatarController.analyser);
              
              audioEl.onplay = () => {
                avatarController.isPlaying = true;
                avatarController.setEmotion('happy');
                source.start(0);
                console.log('[Greeting] Lip-sync started');
              };
              
              audioEl.onended = () => {
                avatarController.isPlaying = false;
                avatarController.setEmotion('neutral');
                console.log('[Greeting] Audio ended');
              };
            })
            .catch(e => console.warn('[Greeting] Lip-sync setup failed:', e));
        }
        
        try {
          await audioEl.play();
          console.log('[Greeting] ✅ Greeting played successfully!');
        } catch (e) {
          console.error('[Greeting] Play error:', e);
        }
      }
      
      // Reset status
      setTimeout(() => {
        statusEl.textContent = IDLE_TEXT;
        statusEl.style.color = '';
      }, 2000);
    }
  } catch (error) {
    console.error('[Greeting] Failed to get greeting:', error);
    const statusEl = document.getElementById('recordStatus');
    statusEl.textContent = '❌ Қате: ' + error.message;
    statusEl.style.color = 'red';
  }
}


async function playPcmChunk(arrayBuffer, sampleRate, audioCtx) {
  if (!audioCtx) {
    console.error('[Audio] playPcmChunk called but audioCtx is null!');
    return;
  }
  
  // arrayBuffer contains Int16LE PCM mono data
  const int16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  const audioBuffer = audioCtx.createBuffer(1, float32.length, sampleRate);
  audioBuffer.getChannelData(0).set(float32);

  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  
  console.log(`[Audio] Playing PCM chunk: ${int16.length} samples at ${sampleRate}Hz`);
  
  // Connect to avatar analyser for lipsync if available
  if (avatarController && avatarController.analyser) {
    src.connect(avatarController.analyser);
    avatarController.analyser.connect(audioCtx.destination);
    avatarController.isPlaying = true;
    console.log('[Audio] Connected to avatar analyser for lipsync');
    
    // Stop lipsync when audio ends
    src.onended = () => {
      avatarController.isPlaying = false;
      console.log('[Audio] Audio chunk ended');
    };
  } else {
    src.connect(audioCtx.destination);
    console.log('[Audio] No avatar analyser, playing directly to destination');
  }
  
  try {
    src.start();
  } catch (e) {
    console.warn('Audio start error', e);
  }
}
