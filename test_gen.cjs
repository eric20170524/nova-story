const BASE_URL = 'http://127.0.0.1:3000/api';

async function testGen() {
  console.log('Building prompt for character 4 (陆嘉静)...');
  const pRes = await fetch(`${BASE_URL}/characters/4/build-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_type: 'pony', gen_type: 'portrait' })
  });
  const promptData = await pRes.json();
  console.log('Prompt:', promptData.prompt);

  console.log('Triggering asset generation...');
  const gRes = await fetch(`${BASE_URL}/assets/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: {
        prompt: promptData.prompt,
        negative_prompt: promptData.negative_prompt,
        model_type: 'pony',
        mode: 'standard',
        gen_type: 'portrait',
        style_preset: 'xianxia_immortal',
        nsfw_enabled: true
      },
      scene_id: 999994,
      mode: 'standard'
    })
  });
  const gData = await gRes.json();
  console.log('Task ID:', gData.task_id);

  console.log('Polling task status...');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const sRes = await fetch(`${BASE_URL}/assets/status/${gData.task_id}`);
    const sData = await sRes.json();
    console.log(`[${i + 1}] Status:`, sData.status, sData.image_url || sData.error || '');
    if (sData.status === 'completed' || sData.status === 'failed') break;
  }
}

testGen().catch(console.error);
