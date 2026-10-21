/**
 * An approved 定妆 is a saved portrait file that is square or vertical.
 * A 16:9 storyboard plate is not a face lock for turnaround or video.
 */
import fs from 'fs';
import sharp from 'sharp';
import { resolveStaticAssetPath } from '../core/paths';

export class PortraitPlateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortraitPlateError';
  }
}

export type PortraitPlate = {
  url: string;
  width: number;
  height: number;
  path: string;
};

export async function readPortraitPlate(avatarUrl: string | null | undefined): Promise<PortraitPlate> {
  const url = String(avatarUrl || '').trim();
  if (!url) {
    throw new PortraitPlateError('还没有通过的定妆，不能出三视图。请先生成并保存竖幅或正方形定妆。');
  }
  const filePath = resolveStaticAssetPath(url);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new PortraitPlateError('定妆文件不存在，不能出三视图。请先保存竖幅或正方形定妆。');
  }
  const meta = await sharp(filePath).metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  if (width < 8 || height < 8) {
    throw new PortraitPlateError('定妆尺寸无效，不能出三视图。');
  }
  if (width > height * 1.02) {
    throw new PortraitPlateError('定妆是横幅，不能作为三视图的底图。请先换成竖幅或正方形定妆。');
  }
  return { url, width, height, path: filePath };
}
