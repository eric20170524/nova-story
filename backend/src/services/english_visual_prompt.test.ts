import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMService } from './llm';
import {
  assertEnglishFidelity,
  compileEnglishShotPrompt,
  draftEnglishFromCues,
  englishCoversCues,
  extractVisibleBeats,
  optimizeOutboundPrompt,
  setVisualPromptTranslatorForTests,
  setVisualPromptVerifierForTests,
  shotImageMaterialsFromSpec,
  stripPeopleBlockers,
  assetPromptForShot,
  splitSpokenFromPicture,
} from './english_visual_prompt';

const cueTranslator = async (prompt: string) => draftEnglishFromCues(prompt) || 'adult figures, visible action preserved';
test.beforeEach(() => setVisualPromptVerifierForTests(async (facts, english) => ({
  facts: facts.map((_, id) => ({ id, status: /poetic|soft moonlight|quiet emotional|tendril only/.test(english) ? 'missing' : 'preserved', evidence: english })),
})));
test.afterEach(() => {
  setVisualPromptTranslatorForTests(null);
  setVisualPromptVerifierForTests(null);
});

test('visible cues must survive the English prompt', async () => {
  const source = '成年陆尘穿着白色长袍，摘下手套并拥抱青檀';
  assert.equal(await englishCoversCues(source, 'adult, robe, removes, glove, embrace'), true);
  assert.equal(await englishCoversCues(source, 'soft moonlight and a poetic mood'), false);
  await assert.rejects(() => assertEnglishFidelity(source, 'soft moonlight'));
  assert.deepEqual(draftEnglishFromCues(source).split(', '), ['embrace', 'robe', 'glove', 'removes', 'adult']);
});

test('spread legs stay a visible cue when the wording is 双腿大张', async () => {
  assert.equal(await englishCoversCues('双腿大张承受触腕', 'legs spread, tendril'), true);
  assert.equal(await englishCoversCues('双腿大张承受触腕', 'tendril only'), false);
});

test('visible beats quote source sentences and prefer strong cues', () => {
  const beats = extractVisibleBeats([
    { id: 'p_1', text: '他吻了她。她褪下外袍，跨坐在他身上。林轩入殿。' },
  ]);
  assert.deepEqual(beats.map((beat) => beat.text), ['她褪下外袍，跨坐在他身上', '他吻了她']);
  assert.deepEqual(beats[0]?.sourceParagraphIds, ['p_1']);
  assert.equal(beats[0]?.id, 'vb_1');
  const many = extractVisibleBeats([
    { id: 'p_2', text: Array.from({ length: 18 }, (_, index) => `她第${index}次跨坐`).join('。') },
  ]);
  assert.equal(many.length, 16);
});

test('appearance fields stay intact for the text model', () => {
  const materials = shotImageMaterialsFromSpec(
    {
      location: '清暮宫内殿',
      primary_action: '裴雨涵红衣半解',
      primary_subject: '裴雨涵',
      visible_subjects: ['裴雨涵', '陆嘉静'],
      shot_intent: 'wide-action',
      subject_scale: 'full',
    },
    [
      {
        name: '裴雨涵',
        english_name: 'Pei Yuhan',
        visual_tags: { hair: 'voluminous_crimson', clothing: 'low_cut_crimson' },
      },
      {
        name: '陆嘉静',
        visual_tags: { hair: 'long_silky_white', clothing: 'half_unraveled_moon_white' },
      },
    ],
    {
      shotType: 'Wide Shot',
      modelFamily: 'redcraft_krea2',
      styleLighting: 'dramatic chiaroscuro, rim light, semi-realistic material',
    },
  );
  const pei = materials.characters.find((row) => row.name === '裴雨涵');
  const lu = materials.characters.find((row) => row.name === '陆嘉静');
  assert.equal(pei?.appearance.hair, 'voluminous_crimson');
  assert.equal(pei?.appearance.clothing, 'low_cut_crimson');
  assert.equal(lu?.appearance.hair, 'long_silky_white');
  assert.equal(lu?.appearance.clothing, 'half_unraveled_moon_white');
  assert.equal(materials.glossary['裴雨涵'], 'Pei Yuhan');
  assert.equal(materials.shot_type, 'Wide Shot');
  assert.equal(materials.styleLighting, 'dramatic chiaroscuro, rim light, semi-realistic material');
  assert.equal(
    stripPeopleBlockers('palace interior, 16:9, no people, isolated, version one prop prompt'),
    'palace interior, version one prop prompt',
  );
});

test('an appearance field with commas stays one fidelity clause', async () => {
  let seen: string[] = [];
  setVisualPromptVerifierForTests(async (facts, english) => {
    seen = facts;
    return { facts: facts.map((_, id) => ({ id, status: 'preserved' as const, evidence: english })) };
  });
  setVisualPromptTranslatorForTests(async () => 'Lu Chen has soft brows and amber eyes, and he lowers a white robe.');
  await compileEnglishShotPrompt(
    { location: '庭院', primary_action: '陆尘褪下外袍', primary_subject: '陆尘', visible_subjects: ['陆尘'] },
    [{ name: '陆尘', lock: '', appearance: { hair: 'black hair', face: 'soft brows, amber eyes', clothing: 'half_unraveled_moon_white' } }],
  );
  assert.ok(seen.some((fact) => fact.includes('soft brows、amber eyes')));
  assert.equal(seen.includes('amber eyes'), false);
});

test('compiled shot prompts keep appearance fields and fail closed when visible facts disappear', async () => {
  let seenUser = '';
  let seenSystem = '';
  setVisualPromptTranslatorForTests(async (prompt, system) => {
    seenUser = prompt;
    seenSystem = system || '';
    return 'Lu Chen has black hair, lowers a white robe, removes his gloves, and embraces Qing Tan.';
  });
  try {
    const compiled = await compileEnglishShotPrompt(
      {
        shot_intent: 'wide-action',
        shot_type: 'Wide Shot',
        location: '清暮宫',
        primary_action: '成年陆尘褪下白色长袍，摘下手套并拥抱青檀',
        primary_subject: '陆尘',
        visible_subjects: ['陆尘'],
        subject_scale: 'medium-20-40',
      },
      [{ name: '陆尘', lock: '', appearance: { hair: 'black hair', clothing: 'half_unraveled_moon_white' } }],
      {
        modelFamily: 'redcraft_krea2',
        nsfwEnabled: true,
        styleLighting: 'dramatic chiaroscuro, rim light, semi-realistic material',
      },
    );
    assert.match(seenUser, /half_unraveled_moon_white/);
    assert.match(seenUser, /"hair":"black hair"/);
    assert.match(seenUser, /dramatic chiaroscuro/);
    assert.match(seenSystem, /Write every visible_facts text/);
    assert.match(seenUser, /spoken_not_painted/);
    assert.match(seenSystem, /Write hair as hair/);
    assert.match(seenSystem, /NSFW: on/);
    assert.match(compiled.visual_prompt, /lowers a white robe/);
    assert.match(compiled.visual_prompt, /natural uncensored details, erotic sensual atmosphere, soft skin texture/);
    assert.ok(compiled.visual_prompt.indexOf('lowers a white robe') < compiled.visual_prompt.indexOf('natural uncensored details'));
    assert.doesNotMatch(compiled.visual_prompt, /environment-dominant|luxurious silk|:1\.[0-9]/);
    assert.doesNotMatch(compiled.visual_prompt, /[\u3400-\u9fff]/);

    setVisualPromptTranslatorForTests(async () => 'soft moonlight and poetic atmosphere');
    await assert.rejects(
      () => compileEnglishShotPrompt({ location: '清暮宫', primary_action: '她跨坐在他身上' }, ''),
      /dropped visible facts/,
    );

    setVisualPromptTranslatorForTests(async () => '她跨坐 straddling');
    await assert.rejects(
      () => compileEnglishShotPrompt({ location: '清暮宫', primary_action: '她跨坐在他身上' }, ''),
      /Chinese characters/,
    );
  } finally {
    setVisualPromptTranslatorForTests(null);
  }
});

test('outbound optimization keeps an English prompt and does not accept a cue-dropping rewrite', async () => {
  setVisualPromptTranslatorForTests(cueTranslator);
  try {
    const english = await optimizeOutboundPrompt('hero in the old temple, version one prop prompt', { modelFamily: 'pony' });
    assert.equal(english, 'hero in the old temple, version one prop prompt');
    const blocked = await optimizeOutboundPrompt('palace interior, 16:9, no people, isolated', { modelFamily: 'pony' });
    assert.equal(blocked, 'palace interior, 16:9, no people, isolated');
    const undressed = await optimizeOutboundPrompt(
      'robe lowered to the waist, full breasts, half_unraveled_moon_white',
      { modelFamily: 'redcraft_krea2' },
    );
    assert.equal(undressed, 'robe lowered to the waist, full breasts, half_unraveled_moon_white');
    assert.equal(
      await optimizeOutboundPrompt('(lowers the robe:1.35), half_unraveled_moon_white', { modelFamily: 'redcraft_krea2' }),
      '(lowers the robe:1.35), half_unraveled_moon_white',
    );

    const translated = await optimizeOutboundPrompt('她跨坐在他身上，胸前相贴', { modelFamily: 'pony', nsfwEnabled: true });
    assert.match(translated, /straddl/i);
    assert.match(translated, /breast|chest/i);
    assert.doesNotMatch(translated, /[\u3400-\u9fff]/);

    setVisualPromptTranslatorForTests(async () => 'a quiet emotional atmosphere');
    await assert.rejects(
      () => optimizeOutboundPrompt('她跨坐在他身上', { modelFamily: 'pony' }),
      /dropped visible/,
    );
  } finally {
    setVisualPromptTranslatorForTests(null);
  }
});

test('semantic fidelity rejects reversed clothing and facts outside the glossary', async () => {
  const cases = [
    { source: '她脱掉外袍', english: 'A woman wearing a robe stands beside an open window.', status: 'contradicted' as const },
    { source: '她穿着红色夹克，双手交叉', english: 'A woman stands by a window.', status: 'missing' as const },
    { source: '她摘下手套并拥抱来客', english: 'The visitor removes gloves and embraces her.', status: 'contradicted' as const },
  ];
  for (const item of cases) {
    setVisualPromptVerifierForTests(async (facts, english) => {
      assert.equal(facts.join('，'), item.source);
      assert.equal(english, item.english);
      return { facts: facts.map((_, id) => ({ id, status: item.status, evidence: english })) };
    });
    assert.equal(await englishCoversCues(item.source, item.english), false);
  }
});

test('keyword hits never exempt compound facts from a failed auditor result', async () => {
  const source = '陆嘉静端坐如宫主般脊背挺直，月白里衣半敞，锁骨下仙纹随呼吸明灭，正解外袍举行仪式。 with 合欢香，清暮宫内殿 in soft background，门扉半掩隔绝尘世 in soft background，陆嘉静 appearance: long_silky_white';
  const english = 'She sits with her spine perfectly straight while partially unbuttoning her moon-white undergarment. She begins to remove her outer robe for a ritual while the scent of Joyous Union perfume lingers. The background is the inner hall, where half-open doors suggest the separation from the mortal world. long, silky white hair.';
  setVisualPromptVerifierForTests(async () => ({
    facts: [
      { id: 0, status: 'preserved', evidence: 'sits with her spine perfectly straight' },
      { id: 1, status: 'contradicted', evidence: 'partially unbuttoning her moon-white undergarment' },
      { id: 2, status: 'preserved', evidence: 'moon-white undergarment' },
      { id: 3, status: 'preserved', evidence: 'begins to remove her outer robe for a ritual' },
      { id: 4, status: 'missing', evidence: '' },
      { id: 5, status: 'preserved', evidence: 'inner hall' },
      { id: 6, status: 'missing', evidence: '' },
      { id: 7, status: 'contradicted', evidence: 'long, silky white hair' },
    ],
  }));
  await assert.rejects(() => assertEnglishFidelity(source, english), /dropped visible facts/);
});

test('synonymous door wording cannot hide omitted cats or project-specific props', async () => {
  setVisualPromptVerifierForTests(async facts => ({ facts: facts.map((_, id) => ({ id, status: 'missing', evidence: '' })) }));
  for (const source of ['门扉半掩且门外有三只白猫', '木门半开且门外有三只白猫', '合欢香旁边有三只白猫']) {
    await assert.rejects(() => assertEnglishFidelity(source, 'A half-open door and incense.'), /dropped visible facts/);
  }
});

test('production fidelity path audits every clause with relational instructions', async () => {
  setVisualPromptVerifierForTests(null);
  const provider = LLMService.getLocalProvider();
  const originalProviderFactory = LLMService.getLocalProvider;
  LLMService.getLocalProvider = () => provider;
  const original = provider.generateStructured;
  let calls = 0;
  provider.generateStructured = async (prompt, schema, system) => {
    calls++;
    const request = JSON.parse(prompt);
    assert.deepEqual(request.sourceFacts, [{ id: 0, fact: '她穿着红色夹克' }, { id: 1, fact: '双手交叉' }]);
    assert.match(system || '', /subject, action, object, color, clothing state/);
    assert.match(system || '', /wearing a robe contradicts removing it/);
    return schema.parse({ facts: [
      { id: 0, status: 'preserved', evidence: 'red jacket' },
      { id: 1, status: 'missing', evidence: '' },
    ] });
  };
  try {
    await assert.rejects(() => assertEnglishFidelity('她穿着红色夹克，双手交叉', 'A woman in a red jacket.'), /dropped visible facts/);
    assert.equal(calls, 1);
  } finally {
    provider.generateStructured = original;
    LLMService.getLocalProvider = originalProviderFactory;
  }
});

test('semantic audit fails closed on incomplete, duplicate, or invented evidence', async () => {
  for (const facts of [
    [],
    [{ id: 0, status: 'preserved' as const, evidence: 'A woman.' }, { id: 0, status: 'preserved' as const, evidence: 'A woman.' }],
    [{ id: 0, status: 'preserved' as const, evidence: 'red jacket' }],
  ]) {
    setVisualPromptVerifierForTests(async () => ({ facts }));
    await assert.rejects(() => assertEnglishFidelity('她穿着红色夹克', 'A woman.'), /dropped visible facts/);
  }
});

test('a dropped picture fact is rewritten once, then the passing paragraph is reused', async () => {
  let calls = 0;
  setVisualPromptTranslatorForTests(async () => ++calls === 1 ? 'A woman wearing a robe.' : 'She removes her robe.');
  setVisualPromptVerifierForTests(async (facts, english) => ({
    facts: facts.map((_, id) => ({ id, status: english.includes('wearing') ? 'contradicted' as const : 'preserved' as const, evidence: english })),
  }));
  const contract = { location: '庭院', primary_action: '她脱掉外袍' };
  const good = await compileEnglishShotPrompt(contract);
  assert.match(good.visual_prompt, /removes her robe/);
  await compileEnglishShotPrompt(contract);
  assert.equal(calls, 2);

  let badCalls = 0;
  setVisualPromptTranslatorForTests(async () => {
    badCalls += 1;
    return 'A woman wearing a robe.';
  });
  const reversed = { location: '庭院', primary_action: '她穿上外袍' };
  await assert.rejects(() => compileEnglishShotPrompt(reversed), /contradicted/);
  assert.equal(badCalls, 2);
  await assert.rejects(() => compileEnglishShotPrompt(reversed), /contradicted/);
  assert.equal(badCalls, 4);
});

test('an appearance field stays when its own words are already in the English', async () => {
  setVisualPromptVerifierForTests(async () => ({
    facts: [{ id: 0, status: 'contradicted' as const, evidence: 'different hair' }],
  }));
  await assertEnglishFidelity('陆嘉静的头发：long_silky_white', 'She has long silky white hair.');
  setVisualPromptVerifierForTests(async () => ({
    facts: [{ id: 0, status: 'missing' as const, evidence: '' }],
  }));
  await assert.rejects(
    () => assertEnglishFidelity('陆嘉静的头发：long_silky_white', 'She has short black hair.'),
    /dropped visible facts/,
  );
});

test('quoted speech is not a still fact, and the action around it still has to be painted', async () => {
  const split = splitSpokenFromPicture('她坐着，红衣褪至腰间，低声道：‘是你么？’');
  assert.deepEqual(split.spoken, ['是你么？']);
  assert.match(split.picture, /红衣褪至腰间/);
  assert.doesNotMatch(split.picture, /是你么/);

  let seen: string[] = [];
  setVisualPromptVerifierForTests(async (facts, english) => {
    seen = facts;
    assert.equal(english.includes('是你么'), false);
    return {
      facts: facts.map((fact, id) => ({
        id,
        status: fact.includes('红衣褪至腰间') ? 'missing' as const : 'preserved' as const,
        evidence: fact.includes('红衣褪至腰间') ? '' : english,
      })),
    };
  });
  setVisualPromptTranslatorForTests(async () => 'She sits in the inner hall.');
  await assert.rejects(
    () => compileEnglishShotPrompt({
      location: '内殿',
      primary_action: '她坐着，红衣褪至腰间，低声道：‘是你么？’',
    }),
    /红衣褪至腰间/,
  );
  assert.equal(seen.some((fact) => fact.includes('是你么')), false);
  assert.equal(seen.some((fact) => fact.includes('红衣褪至腰间')), true);
});

test('standalone empty locations and isolated props retain their outbound constraints', async () => {
  const asset = 'courtyard, no people, isolated';
  assert.equal(assetPromptForShot(asset, { visible_subjects: ['hero'] }, 'hero walks'), '');
  assert.equal(assetPromptForShot(asset, { subject_scale: 'absent' }, 'empty courtyard'), asset);
  assert.equal(assetPromptForShot(asset, { visible_subjects: ['hero'], subject_scale: 'absent' }, 'no people in the courtyard'), asset);
  assert.equal(assetPromptForShot(asset, { visible_subjects: ['hero'] }, 'no people in the courtyard'), '');
  assert.equal(assetPromptForShot(asset, { visible_subjects: ['paw-only'] }, 'courtyard'), asset);
  assert.equal(assetPromptForShot(asset, {}, 'courtyard'), asset);
  assert.equal(await optimizeOutboundPrompt('empty courtyard, no people'), 'empty courtyard, no people');
  assert.equal(await optimizeOutboundPrompt('a red glove, isolated, no people'), 'a red glove, isolated, no people');
  setVisualPromptTranslatorForTests(async () => 'An empty courtyard, no people, isolated');
  const translated = await optimizeOutboundPrompt('空庭院, no people, isolated');
  assert.match(translated, /no people/);
  assert.match(translated, /isolated/);
});
