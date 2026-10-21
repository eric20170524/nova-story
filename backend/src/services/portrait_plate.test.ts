import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import sharp from 'sharp';
import { resolveStaticAssetPath } from '../core/paths';
import { PortraitPlateError, readPortraitPlate } from './portrait_plate';

test('a portrait plate must be a saved square or vertical file', async () => {
  const write = async (name: string, width: number, height: number) => {
    const url = `/static/generated/${name}`;
    const file = resolveStaticAssetPath(url);
    fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    await sharp({
      create: { width, height, channels: 3, background: { r: 20, g: 30, b: 40 } },
    }).png().toFile(file);
    return { url, file };
  };
  const stamp = `${process.pid}-${Date.now()}`;
  const vertical = await write(`portrait-plate-vertical-${stamp}.png`, 64, 96);
  const square = await write(`portrait-plate-square-${stamp}.png`, 64, 64);
  const wide = await write(`portrait-plate-wide-${stamp}.png`, 96, 64);
  const tiny = await write(`portrait-plate-tiny-${stamp}.png`, 4, 8);
  try {
    const accepted = await readPortraitPlate(vertical.url);
    assert.equal(accepted.width, 64);
    assert.equal(accepted.height, 96);
    assert.equal((await readPortraitPlate(square.url)).width, 64);
    await assert.rejects(readPortraitPlate(wide.url), (error: unknown) => {
      assert.ok(error instanceof PortraitPlateError);
      assert.match((error as Error).message, /定妆是横幅/);
      return true;
    });
    await assert.rejects(readPortraitPlate(tiny.url), /定妆尺寸无效/);
    await assert.rejects(readPortraitPlate(''), /还没有通过的定妆/);
    await assert.rejects(readPortraitPlate(`/static/generated/missing-portrait-plate-${stamp}.png`), /定妆文件不存在/);
  } finally {
    for (const item of [vertical, square, wide, tiny]) {
      try { fs.unlinkSync(item.file); } catch { /* already gone */ }
    }
  }
});
