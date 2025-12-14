// Helper script to download and use a VRM model from VRoid Hub or other sources
// Usage: Include this in kiosk.js or run separately to fetch avatar

export async function downloadVRMModel(url, saveName = 'avatar.vrm') {
  try {
    console.log('Downloading VRM model from:', url);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const blob = await response.blob();
    
    // Create download link
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = saveName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
    
    console.log('✅ VRM model downloaded:', saveName);
    return blob;
  } catch (error) {
    console.error('Failed to download VRM model:', error);
    return null;
  }
}

// Example free VRM models (paste these URLs into browser or use in code)
export const SAMPLE_VRM_MODELS = {
  // These are example URLs - replace with actual VRM model URLs
  sample1: 'https://hub.vroid.com/characters/...',
  sample2: 'https://cdn.readyplayer.me/...',
  
  // Ready Player Me API endpoint (requires API key)
  readyPlayerMe: 'https://api.readyplayer.me/v1/avatars',
};

// Quick test function - call this from browser console
export async function testAvatarLoad(vrmUrl) {
  const container = document.getElementById('avatar3dContainer');
  if (!container || !window.AvatarController) {
    console.error('Avatar container or controller not found');
    return;
  }
  
  const avatar = new window.AvatarController(container);
  await avatar.loadAvatar(vrmUrl);
  console.log('✅ Avatar loaded from:', vrmUrl);
}

// Usage in browser console:
// import('./avatar_loader.js').then(m => m.testAvatarLoad('YOUR_VRM_URL_HERE'))
