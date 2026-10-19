import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMService } from './llm';
import { GpuLeaseService } from './gpu_lease_service';
import {
  assertEnglishFidelity,
  compileEnglishShotPrompt,
  composeShotImagePrompt,
  draftEnglishFromCues,
  englishCoversCues,
  extractVisibleBeats,
  optimizeOutboundPrompt,
  setLocalTextModelEnsureForTests,
  setVisualPromptTranslatorForTests,
  setVisualPromptVerifierForTests,
  UnverifiedVisualPrompt,
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
  setLocalTextModelEnsureForTests(null);
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

test('compiled shot prompts keep appearance fields and retain a missed fact for review', async () => {
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
      (error: unknown) => error instanceof UnverifiedVisualPrompt && /soft moonlight/.test(error.prompt),
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

test('outbound optimization keeps an English prompt and continues when the picture check still fails', async () => {
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

    let failedTranslations = 0;
    setVisualPromptTranslatorForTests(async () => { failedTranslations++; return 'a quiet emotional atmosphere'; });
    await assert.rejects(
      () => optimizeOutboundPrompt('她跨坐在他身上', { modelFamily: 'pony' }),
      (error: any) => error.prompt === 'a quiet emotional atmosphere',
    );
    await assert.rejects(() => optimizeOutboundPrompt('她跨坐在他身上', { modelFamily: 'pony' }));
    assert.equal(failedTranslations, 2, 'an unverified outbound translation must be checked again');
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
    assert.equal(calls, 2);
  } finally {
    provider.generateStructured = original;
    LLMService.getLocalProvider = originalProviderFactory;
  }
});

test('only same-state evidence certifies a fact; unrelated and opposite evidence remain retryable', async () => {
  setVisualPromptVerifierForTests(null);
  const provider = LLMService.getLocalProvider();
  const originalProviderFactory = LLMService.getLocalProvider;
  LLMService.getLocalProvider = () => provider;
  const original = provider.generateStructured;
  let calls = 0;
  const script = (relation: 'same' | 'unrelated' | 'opposite') => {
    provider.generateStructured = async (prompt, schema) => {
      calls++;
      const request = JSON.parse(prompt);
      if (request.sourceFacts) {
        return schema.parse({ facts: [{ id: 0, status: 'contradicted', evidence: 'cloud-patterned brocade bed' }] });
      }
      return schema.parse({ facts: [{ id: 0, relation }] });
    };
  };
  try {
    const source = '清暮宫·云锦榻';
    const english = 'In the Qingmu Palace on a cloud-patterned brocade bed, she rests.';
    script('unrelated');
    await assert.rejects(() => assertEnglishFidelity(source, english), /dropped visible facts/);
    const firstCalls = calls;
    await assert.rejects(() => assertEnglishFidelity(source, english), /dropped visible facts/);
    assert.equal(calls, firstCalls * 2, 'unrelated evidence must not cache a passing result');
    script('same');
    await assertEnglishFidelity(source, english);
    const verifiedCalls = calls;
    await assertEnglishFidelity(source, english);
    assert.equal(calls, verifiedCalls, 'same-state evidence can be reused after verification');
    script('opposite');
    await assert.rejects(
      () => assertEnglishFidelity('她躺在云锦榻上', 'She stands away from the cloud-patterned brocade bed.'),
      /contradicted/,
    );
  } finally {
    provider.generateStructured = original;
    LLMService.getLocalProvider = originalProviderFactory;
  }
});

test('unrelated evidence does not cache a composed paragraph or an outbound translation', async () => {
  setVisualPromptVerifierForTests(null);
  let translations = 0;
  const english = 'An empty courtyard.';
  setVisualPromptTranslatorForTests(async () => { translations++; return english; });
  const original = LLMService.getLocalProvider;
  LLMService.getLocalProvider = () => ({
    async generateStructured(prompt: string) {
      const payload = JSON.parse(prompt);
      return payload.sourceFacts
        ? { facts: [{ id: 0, status: 'contradicted', evidence: english }] }
        : { facts: [{ id: 0, relation: 'unrelated' }] };
    },
  } as any);
  try {
    const source = '主角拿着红杯';
    const materials = shotImageMaterialsFromSpec({ primary_action: source });
    const kept = (error: unknown) => {
      assert.equal((error as { prompt?: string }).prompt, english);
      return true;
    };
    await assert.rejects(() => composeShotImagePrompt(materials), kept);
    await assert.rejects(() => composeShotImagePrompt(materials), kept);
    assert.equal(translations, 4, 'each unverified composition must be generated and rewritten again');
    await assert.rejects(() => optimizeOutboundPrompt(source), kept);
    await assert.rejects(() => optimizeOutboundPrompt(source), kept);
    assert.equal(translations, 6, 'unverified outbound translations must not be cached');
  } finally { LLMService.getLocalProvider = original; }
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
  await assert.rejects(() => compileEnglishShotPrompt(reversed), (error: any) => /wearing a robe/.test(error.prompt));
  assert.equal(badCalls, 2);
  await Promise.all([
    compileEnglishShotPrompt(reversed).catch(() => undefined),
    compileEnglishShotPrompt(reversed).catch(() => undefined),
  ]);
  assert.equal(badCalls, 4, 'a failed picture check must not certify the prompt for reuse');
});

test('oriental_realistic prepends the East Asian face lock after the picture check', async () => {
  setVisualPromptTranslatorForTests(async () => 'Pei Yuhan has voluminous crimson hair and wears a red robe.');
  try {
    const prompt = await composeShotImagePrompt(
      shotImageMaterialsFromSpec(
        { primary_action: '她穿着红袍', visible_subjects: ['裴雨涵'] },
        [{ name: '裴雨涵', visual_tags: { hair: 'voluminous_crimson' } }],
      ),
      { stylePreset: 'oriental_realistic' },
    );
    assert.match(prompt, /^oriental realistic style, photorealistic, delicate East Asian facial features/i);
    assert.match(prompt, /soft East Asian eyelids/i);
    assert.match(prompt, /wears a red robe/);
  } finally {
    setVisualPromptTranslatorForTests(null);
  }
});

test('an unusable audit retries once and does not rewrite a usable paragraph', async () => {
  let paragraphs = 0;
  let audits = 0;
  setVisualPromptTranslatorForTests(async () => { paragraphs += 1; return 'She wears a red robe.'; });
  setVisualPromptVerifierForTests(null);
  const original = LLMService.getLocalProvider;
  const provider = original();
  LLMService.getLocalProvider = () => provider;
  const originalGenerate = provider.generateStructured.bind(provider);
  provider.generateStructured = (async (prompt: string, schema: any) => {
    const payload = JSON.parse(prompt);
    if (!payload.sourceFacts) return originalGenerate(prompt, schema);
    audits += 1;
    if (audits === 1) throw new Error('timeout');
    return schema.parse({
      facts: payload.sourceFacts.map((_: unknown, id: number) => ({ id, status: 'preserved', evidence: 'red robe' })),
    });
  }) as typeof provider.generateStructured;
  try {
    const prompt = await composeShotImagePrompt(shotImageMaterialsFromSpec({ primary_action: '她穿着红袍走入未复核的庭院' }));
    assert.match(prompt, /red robe/);
    assert.equal(paragraphs, 1);
    assert.equal(audits, 2);
  } finally {
    provider.generateStructured = originalGenerate;
    LLMService.getLocalProvider = original;
    setVisualPromptTranslatorForTests(null);
  }
});

test('an audit that never returns a verdict keeps the paragraph unverified', async () => {
  let paragraphs = 0;
  setVisualPromptTranslatorForTests(async () => { paragraphs += 1; return 'She wears a red robe in the side court.'; });
  setVisualPromptVerifierForTests(null);
  const original = LLMService.getLocalProvider;
  LLMService.getLocalProvider = () => ({ async generateStructured() { throw new Error('timeout'); } }) as any;
  try {
    await assert.rejects(
      () => composeShotImagePrompt(shotImageMaterialsFromSpec({ primary_action: '她穿着红袍停在偏院' })),
      (error: unknown) => error instanceof UnverifiedVisualPrompt
        && error.message.startsWith('AUDIT_INCOMPLETE')
        && error.prompt.includes('side court')
        && paragraphs === 1,
    );
  } finally {
    LLMService.getLocalProvider = original;
    setVisualPromptTranslatorForTests(null);
  }
});

test('appearance words do not turn a missing or swapped attribute into a pass', async () => {
  setVisualPromptVerifierForTests(async () => ({
    facts: [{ id: 0, status: 'missing' as const, evidence: '' }],
  }));
  await assert.rejects(
    () => assertEnglishFidelity('陆嘉静的头发：long_silky_white', 'She has long silky white hair.'),
    /dropped visible facts/,
  );
  await assert.rejects(
    () => assertEnglishFidelity('林岚的服装：red dress', 'Chen Yue wears a red dress.'),
    /dropped visible facts/,
  );
});

test('swapped character attributes stay rejected and are not cached as verified', async () => {
  const cases = [
    ['林岚的服装：red dress，陈月的服装：blue coat', 'Lin Lan wears a blue coat. Chen Yue wears a red dress.'],
    ['林岚的头发：black hair，陈月的头发：blonde hair', 'Lin Lan has blonde hair. Chen Yue has black hair.'],
    ['林岚的配饰：red glove，陈月的配饰：blue fan', 'Lin Lan holds a blue fan. Chen Yue holds a red glove.'],
  ] as const;
  for (const [source, english] of cases) {
    let calls = 0;
    setVisualPromptVerifierForTests(async (facts) => {
      calls += 1;
      return { facts: facts.map((fact, id) => ({ id, status: 'contradicted' as const, evidence: english })) };
    });
    await assert.rejects(() => assertEnglishFidelity(source, english), /dropped visible facts/);
    const first = calls;
    await assert.rejects(() => assertEnglishFidelity(source, english), /dropped visible facts/);
    assert.equal(calls, first * 2, source);
    assert.ok(first > 0);
  }
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
    (error: any) => error.prompt === 'She sits in the inner hall.',
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

test('a cache miss starts the local text model once, and the stored paragraph does not start it again', async () => {
  setVisualPromptTranslatorForTests(null);
  const order: string[] = [];
  setLocalTextModelEnsureForTests(async () => { order.push('ensure'); });
  const original = LLMService.getLocalProvider;
  const provider = original();
  LLMService.getLocalProvider = () => ({
    ...provider,
    async generateStructured() {
      order.push('model');
      return { prompt: 'She walks up the jade steps in a half-open red robe.' };
    },
  } as typeof provider);
  const materials = {
    facts: [{ id: 'primary_action', text: '缓存未命中专用：她朝玉阶走来，红衣半解', binding: [] }],
    characters: [],
    location: '清暮宫玉阶',
    shot_intent: 'wide-action',
    shot_type: 'Wide Shot',
    subject_scale: 'full',
    modelFamily: 'pony',
    nsfwEnabled: false,
    styleLighting: '',
    glossary: {},
  };
  try {
    const first = await composeShotImagePrompt(materials);
    const second = await composeShotImagePrompt(materials);
    assert.deepEqual(order, ['ensure', 'model']);
    assert.match(first, /jade steps/);
    assert.equal(second, first);
  } finally {
    LLMService.getLocalProvider = original;
  }
});

test('concurrent image and translation requests share generation and audit; all picture inputs invalidate reuse', async () => {
  let translations = 0; let audits = 0;
  setVisualPromptTranslatorForTests(async () => { translations++; await new Promise(resolve => setImmediate(resolve)); return 'The hero holds a red cup in the courtyard.'; });
  setVisualPromptVerifierForTests(async (facts, english) => {
    audits++;
    return { facts: facts.map((_, id) => ({ id, status: 'preserved' as const, evidence: english })) };
  });
  const original = shotImageMaterialsFromSpec({ location: '庭院', primary_action: '主角拿着红杯', visible_subjects: ['主角'] }, [{ name: '主角', visual_tags: { hair: 'black hair' } }]);
  const [a, b] = await Promise.all([composeShotImagePrompt(original), composeShotImagePrompt(original)]);
  assert.equal(a, b); assert.equal(translations, 1); assert.equal(audits, 1);
  for (const changed of [
    { ...original, camera_angle: 'Low-angle' },
    { ...original, camera_movement: 'Slow pan' },
    { ...original, styleLighting: 'moonlight' },
    { ...original, continuity_states: [{ entity: '主角', attribute: 'holding', value: '红杯' }] },
    { ...original, characters: [{ name: '主角', appearance: { ...original.characters[0]!.appearance, hair: 'white hair' } }] },
    { ...original, glossary: { 主角: 'Hero' } },
  ]) await composeShotImagePrompt(changed);
  assert.equal(translations, 7);
  await composeShotImagePrompt(original, { variant: 'version-two' });
  await composeShotImagePrompt(original, { variant: 'version-two' });
  assert.equal(translations, 8);
  const before = audits;
  await Promise.all([optimizeOutboundPrompt('主角拿着红杯'), optimizeOutboundPrompt('主角拿着红杯')]);
  await optimizeOutboundPrompt('主角拿着红杯');
  assert.equal(translations, 9); assert.equal(audits, before + 1);
  await assertEnglishFidelity('主角拿着红杯', 'The hero holds a red cup in the courtyard.');
  assert.equal(audits, before + 1);
  await assertEnglishFidelity('主角拿着红杯', 'The hero holds the red cup.');
  assert.equal(audits, before + 2);
});

test('a local prompt miss waits for a guarded image instead of interrupting its GPU work', async () => {
  GpuLeaseService.resetForTesting();
  const image = await GpuLeaseService.acquireLease('active-image', 'image');
  GpuLeaseService.guardLeaseForPrompt('active-image', 'image-prompt');
  let starts = 0;
  setVisualPromptTranslatorForTests(null);
  setLocalTextModelEnsureForTests(async () => { starts++; });
  const factory = LLMService.getLocalProvider;
  LLMService.getLocalProvider = () => ({ async generateStructured() { return { prompt: 'The hero stands in the courtyard.' }; } } as any);
  try {
    const materials = shotImageMaterialsFromSpec({ location: '庭院', primary_action: '主角站着' });
    const pending = composeShotImagePrompt(materials);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 0);
    assert.equal(GpuLeaseService.getQueueLength(), 1);
    GpuLeaseService.releaseLease(image.lease_id, 'active-image');
    assert.equal(starts, 0);
    GpuLeaseService.confirmPromptStopped('image-prompt');
    await pending;
    assert.equal(starts, 1);
    await composeShotImagePrompt(materials);
    assert.equal(starts, 1);
    assert.equal(GpuLeaseService.getCurrentLease(), null);
  } finally { LLMService.getLocalProvider = factory; GpuLeaseService.resetForTesting(); }
});

test('a GPU owner verifies before a queued shared audit and releases subsequent image and video tasks', async t => {
  for (const flow of ['composition', 'translation'] as const) {
    await t.test(flow, async () => {
      setVisualPromptTranslatorForTests(null);
      setVisualPromptVerifierForTests(null);
      GpuLeaseService.resetForTesting();
      let starts = 0;
      setLocalTextModelEnsureForTests(async () => { starts++; });
      const original = LLMService.getLocalProvider;
      let started!: () => void;
      const modelStarted = new Promise<void>(resolve => { started = resolve; });
      let finish!: () => void;
      const modelGate = new Promise<void>(resolve => { finish = resolve; });
      const source = '主角拿着红杯';
      const english = 'The hero holds a red cup.';
      let audits = 0;
      const generate = async () => { started(); await modelGate; return english; };
      LLMService.getLocalProvider = () => ({
        generateText: generate,
        async generateStructured(prompt: string) {
          const payload = JSON.parse(prompt);
          if (payload.visible_facts) return { prompt: await generate() };
          audits++;
          return { facts: payload.sourceFacts.map((_: unknown, id: number) => ({ id, status: 'preserved', evidence: english })) };
        },
      } as any);
      const waiting: Promise<unknown>[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const generation = flow === 'composition'
          ? composeShotImagePrompt(shotImageMaterialsFromSpec({ primary_action: source }))
          : optimizeOutboundPrompt(source);
        waiting.push(generation);
        void generation.catch(() => {});
        await modelStarted;
        const audit = assertEnglishFidelity(source, english);
        waiting.push(audit);
        void audit.catch(() => {});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(GpuLeaseService.getQueueLength(), 1);
        const image = GpuLeaseService.acquireLease(`next-image-${flow}`, 'image');
        const video = GpuLeaseService.acquireLease(`next-video-${flow}`, 'video');
        waiting.push(image, video);
        void image.catch(() => {});
        void video.catch(() => {});
        finish();
        const [paragraph] = await Promise.race([
          Promise.all([generation, audit]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('GPU owner is blocked by its queued audit')), 1000); }),
        ]);
        assert.equal(paragraph, english);
        assert.equal(audits, 1, 'the queued audit must reuse the result verified by the GPU owner');
        const imageLease = await image;
        assert.equal(GpuLeaseService.getCurrentLease()?.kind, 'image');
        const startsBeforeCached = starts;
        await assertEnglishFidelity(source, english);
        assert.equal(starts, startsBeforeCached, 'cached verification must bypass GPU acquisition and model startup');
        assert.equal(GpuLeaseService.getQueueLength(), 1);
        GpuLeaseService.releaseLease(imageLease.lease_id, imageLease.owner_task_id);
        const videoLease = await video;
        assert.equal(GpuLeaseService.getCurrentLease()?.kind, 'video');
        GpuLeaseService.releaseLease(videoLease.lease_id, videoLease.owner_task_id);
        assert.equal(GpuLeaseService.getCurrentLease(), null);
        assert.equal(GpuLeaseService.getQueueLength(), 0);
      } finally {
        clearTimeout(timer);
        finish();
        GpuLeaseService.resetForTesting();
        await Promise.allSettled(waiting);
        LLMService.getLocalProvider = original;
        setLocalTextModelEnsureForTests(null);
        setVisualPromptVerifierForTests(null);
      }
    });
  }
});
