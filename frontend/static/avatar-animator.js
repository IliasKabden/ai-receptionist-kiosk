/**
 * Simple Avatar Animator
 * Animates a static photo with blinking and subtle head movements
 * Pure canvas, no heavy dependencies
 */

class SimpleAvatarAnimator {
  constructor() {
    this.canvas = document.getElementById('avatarCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.avatarImage = null;
    this.isAnimating = false;
    this.startTime = Date.now();
    this.skinColor = null; // [r,g,b]
    this.blink = {
      active: false,
      stage: 0, // 0: half, 1: closed, 2: half, 3: open
      stageStart: 0,
      nextAt: 3 + Math.random() * 5, // seconds from start
      durationsMs: [120, 110, 120, 80]
    };
    
    this.setupCanvas();
    this.loadImage();
  }

  setupCanvas() {
    const wrapper = document.getElementById('avatarWrapper');
    this.canvas.width = wrapper.offsetWidth;
    this.canvas.height = wrapper.offsetHeight;
    
    window.addEventListener('resize', () => {
      this.canvas.width = wrapper.offsetWidth;
      this.canvas.height = wrapper.offsetHeight;
    });
  }

  loadImage() {
    console.log('[Avatar] Loading avatar photo...');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.avatarImage = img;
      console.log('[Avatar] ✅ Avatar image loaded, starting animation');
      this.startAnimation();
    };
    img.onerror = () => {
      console.error('[Avatar] Failed to load avatar image');
      this.fallbackToStatic();
    };
    img.src = '/media/avatar_photo.jpg';
  }

  startAnimation() {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.animate();
  }

  animate() {
    if (!this.isAnimating || !this.avatarImage) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    
    // Clear canvas
    this.ctx.fillStyle = '#1a1a1a';
    this.ctx.fillRect(0, 0, w, h);

    // Get animation time
    const elapsed = (Date.now() - this.startTime) / 1000;
    
    // Natural blink scheduler using keyframes: half → closed → half → open
    let blinkAmount = this.updateBlink(elapsed);

    // Subtle head movements
    const headTilt = Math.sin(elapsed * 0.3) * 2; // ±2 degrees
    const headBob = Math.cos(elapsed * 0.25) * 1; // ±1 pixel

    // console.log(`[Avatar] Blink: ${(blinkAmount * 100).toFixed(0)}% elapsed: ${elapsed.toFixed(1)}s`);

    // Draw image with effects
    this.drawAvatarWithAnimations(blinkAmount, headTilt, headBob);

    requestAnimationFrame(() => this.animate());
  }

  drawAvatarWithAnimations(blinkAmount, tilt, bob) {
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Calculate image dimensions to fit canvas
    const imgAspect = this.avatarImage.width / this.avatarImage.height;
    const canvasAspect = w / h;
    
    let drawWidth, drawHeight, offsetX, offsetY;
    
    if (imgAspect > canvasAspect) {
      drawHeight = h;
      drawWidth = h * imgAspect;
      offsetX = (w - drawWidth) / 2;
      offsetY = 0;
    } else {
      drawWidth = w;
      drawHeight = w / imgAspect;
      offsetX = 0;
      offsetY = (h - drawHeight) / 2;
    }

    this.ctx.save();
    
    // Apply subtle head movements
    this.ctx.translate(w / 2, h / 2);
    this.ctx.rotate(tilt * Math.PI / 180);
    this.ctx.scale(1 + bob * 0.01, 1 + bob * 0.01);  // Slight zoom with bob
    this.ctx.translate(-w / 2, -h / 2 + bob);
    
    // Draw avatar image with slight opacity change for "breathing"
    const breathing = 0.95 + Math.sin((Date.now() - this.startTime) / 1000 * 0.5) * 0.05;
    this.ctx.globalAlpha = breathing;
    this.ctx.drawImage(
      this.avatarImage,
      offsetX,
      offsetY,
      drawWidth,
      drawHeight
    );
    this.ctx.globalAlpha = 1;

    // Compute skin tone once (after image is drawn)
    if (!this.skinColor) {
      this.skinColor = this.sampleSkinColor(offsetX, offsetY, drawWidth, drawHeight);
    }

    // Draw eyelid overlay based on blinkAmount
    if (blinkAmount > 0) {
      this.drawEyelids(blinkAmount, offsetX, offsetY, drawWidth, drawHeight);
    }

    this.ctx.restore();
  }

  updateBlink(elapsedSec) {
    // When not active, schedule blink at nextAt
    if (!this.blink.active) {
      if (elapsedSec >= this.blink.nextAt) {
        this.blink.active = true;
        this.blink.stage = 0;
        this.blink.stageStart = elapsedSec;
      }
      return 0; // eyes open
    }

    // Advance stages according to durations
    const stageDur = this.blink.durationsMs[this.blink.stage] / 1000;
    if (elapsedSec - this.blink.stageStart >= stageDur) {
      this.blink.stage += 1;
      this.blink.stageStart = elapsedSec;
    }

    // If finished all stages, reset
    if (this.blink.stage >= 4) {
      this.blink.active = false;
      this.blink.nextAt = elapsedSec + 3 + Math.random() * 5; // 3–8s until next blink
      return 0;
    }

    // Map stage to blinkAmount
    switch (this.blink.stage) {
      case 0: return 0.5; // half-closed
      case 1: return 1.0; // closed
      case 2: return 0.5; // half-closed
      case 3: return 0.0; // open
      default: return 0.0;
    }
  }

  sampleSkinColor(offsetX, offsetY, drawWidth, drawHeight) {
    // Sample a small patch near the forehead to estimate skin tone
    const w = this.canvas.width;
    const h = this.canvas.height;
    const sampleW = Math.max(4, Math.floor(drawWidth * 0.08));
    const sampleH = Math.max(4, Math.floor(drawHeight * 0.04));
    const sx = Math.floor(offsetX + drawWidth * 0.45);
    const sy = Math.floor(offsetY + drawHeight * 0.18);

    try {
      const imgData = this.ctx.getImageData(sx, sy, sampleW, sampleH).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < imgData.length; i += 4) {
        r += imgData[i];
        g += imgData[i + 1];
        b += imgData[i + 2];
        count++;
      }
      r = Math.floor(r / count);
      g = Math.floor(g / count);
      b = Math.floor(b / count);
      return [r, g, b];
    } catch (e) {
      console.warn('[Avatar] Skin sampling failed, using default tone', e);
      return [224, 190, 170];
    }
  }

  rgbaSkin(alpha) {
    const [r, g, b] = this.skinColor || [224, 190, 170];
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  drawEyelids(blinkAmount, offsetX, offsetY, drawWidth, drawHeight) {
    const ctx = this.ctx;

    // Define eye region relative to drawn image
    const ex = offsetX + drawWidth * 0.20;
    const ew = drawWidth * 0.60;
    const ey = offsetY + drawHeight * 0.34;
    const eh = drawHeight * 0.22;

    // Compute coverage heights
    const topH = blinkAmount * eh * 0.70;
    const botH = blinkAmount * eh * 0.55;

    // Upper eyelid gradient (skin → transparent)
    const gradTop = ctx.createLinearGradient(0, ey, 0, ey + topH);
    gradTop.addColorStop(0, this.rgbaSkin(0.90));
    gradTop.addColorStop(1, this.rgbaSkin(0.00));
    ctx.fillStyle = gradTop;
    ctx.fillRect(ex, ey, ew, topH);

    // Upper lash line
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(ex, ey + topH - 1.5, ew, 1.5);

    // Lower eyelid gradient (transparent → skin)
    const bottomY = ey + eh;
    const gradBot = ctx.createLinearGradient(0, bottomY - botH, 0, bottomY);
    gradBot.addColorStop(0, this.rgbaSkin(0.00));
    gradBot.addColorStop(1, this.rgbaSkin(0.85));
    ctx.fillStyle = gradBot;
    ctx.fillRect(ex, bottomY - botH, ew, botH);

    // Lower lash line
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(ex, bottomY - botH, ew, 1.2);

    // Soft eye shadow overlay for cohesion
    ctx.globalAlpha = 0.06 * blinkAmount;
    ctx.fillStyle = 'black';
    ctx.fillRect(ex, ey, ew, eh);
    ctx.globalAlpha = 1.0;
  }

  generateBlinkFrames() {
    if (!this.avatarImage) {
      console.warn('[Avatar] No image loaded yet');
      return [];
    }

    const levels = [0.5, 1.0, 0.5, 0.0];
    const names = ['half', 'closed', 'half', 'open'];
    const w = this.canvas.width;
    const h = this.canvas.height;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');

    const urls = [];

    // Compute draw rect (no tilt/bob for clean frames)
    const imgAspect = this.avatarImage.width / this.avatarImage.height;
    const canvasAspect = w / h;
    let drawWidth, drawHeight, offsetX, offsetY;
    if (imgAspect > canvasAspect) {
      drawHeight = h;
      drawWidth = h * imgAspect;
      offsetX = (w - drawWidth) / 2;
      offsetY = 0;
    } else {
      drawWidth = w;
      drawHeight = w / imgAspect;
      offsetX = 0;
      offsetY = (h - drawHeight) / 2;
    }

    // Precompute skin color for offscreen
    octx.fillStyle = '#1a1a1a';
    octx.fillRect(0, 0, w, h);
    octx.drawImage(this.avatarImage, offsetX, offsetY, drawWidth, drawHeight);
    const skin = (function sample(ctx, ox, oy, dw, dh) {
      const sampleW = Math.max(4, Math.floor(dw * 0.08));
      const sampleH = Math.max(4, Math.floor(dh * 0.04));
      const sx = Math.floor(ox + dw * 0.45);
      const sy = Math.floor(oy + dh * 0.18);
      try {
        const data = ctx.getImageData(sx, sy, sampleW, sampleH).data;
        let r=0,g=0,b=0,c=0; for (let i=0;i<data.length;i+=4){r+=data[i];g+=data[i+1];b+=data[i+2];c++;}
        return [Math.floor(r/c), Math.floor(g/c), Math.floor(b/c)];
      } catch { return [224,190,170]; }
    })(octx, offsetX, offsetY, drawWidth, drawHeight);

    const rgba = (a) => `rgba(${skin[0]}, ${skin[1]}, ${skin[2]}, ${a})`;

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      // Base
      octx.fillStyle = '#1a1a1a';
      octx.fillRect(0, 0, w, h);
      octx.drawImage(this.avatarImage, offsetX, offsetY, drawWidth, drawHeight);

      // Eye region
      const ex = offsetX + drawWidth * 0.20;
      const ew = drawWidth * 0.60;
      const ey = offsetY + drawHeight * 0.34;
      const eh = drawHeight * 0.22;
      const topH = level * eh * 0.70;
      const botH = level * eh * 0.55;

      // Upper eyelid
      const gradTop = octx.createLinearGradient(0, ey, 0, ey + topH);
      gradTop.addColorStop(0, rgba(0.90));
      gradTop.addColorStop(1, rgba(0.00));
      octx.fillStyle = gradTop;
      octx.fillRect(ex, ey, ew, topH);
      octx.fillStyle = 'rgba(0,0,0,0.12)';
      octx.fillRect(ex, ey + topH - 1.5, ew, 1.5);

      // Lower eyelid
      const bottomY = ey + eh;
      const gradBot = octx.createLinearGradient(0, bottomY - botH, 0, bottomY);
      gradBot.addColorStop(0, rgba(0.00));
      gradBot.addColorStop(1, rgba(0.85));
      octx.fillStyle = gradBot;
      octx.fillRect(ex, bottomY - botH, ew, botH);
      octx.fillStyle = 'rgba(0,0,0,0.10)';
      octx.fillRect(ex, bottomY - botH, ew, 1.2);

      // Soft shadow
      octx.globalAlpha = 0.06 * level;
      octx.fillStyle = 'black';
      octx.fillRect(ex, ey, ew, eh);
      octx.globalAlpha = 1.0;

      const url = off.toDataURL('image/png');
      urls.push(url);

      // Trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = `blink_${String(i+1).padStart(2,'0')}_${names[i]}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    return urls;
  }

  fallbackToStatic() {
    console.log('[Avatar] Falling back to static image');
    this.isAnimating = false;
    const staticImg = document.getElementById('avatarStaticImage');
    if (staticImg) {
      staticImg.style.display = 'block';
    }
    this.canvas.style.display = 'none';
  }
}

// Start when page loads
document.addEventListener('DOMContentLoaded', () => {
  const animator = new SimpleAvatarAnimator();
  // Expose frame generation for manual use
  window.avatarAnimator = animator;
  window.generateBlinkFrames = () => animator.generateBlinkFrames();
});
