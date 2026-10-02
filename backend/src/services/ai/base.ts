import { z } from 'zod';

export type StructuredGenOptions = {
  temperature?: number;
  maxTokens?: number;
  systemInstruction?: string;
};

export type ImageGenerationOptions = {
  width: number;
  height: number;
  aspectRatio: '3:4' | '4:3' | '1:1' | '16:9' | '9:16';
  imageSize: '512' | '1K' | '2K';
  /** Local files for providers that can preserve approved visual identity. */
  referenceImagePaths?: string[];
  /** Reattach a timed-out built-in Codex image job to the normal generation flow. */
  resumeJobId?: string;
};

export interface AIProvider {
    generateText(prompt: string, systemInstruction?: string, options?: { stream?: boolean }): Promise<string>;

    // In Node.js with Zod, we pass the ZodSchema to be parsed instead of a Pydantic Model
    generateStructured<T>(
      prompt: string,
      responseSchema: z.ZodSchema<T>,
      systemInstruction?: string,
      options?: StructuredGenOptions
    ): Promise<T>;

    generateImage(prompt: string, options?: ImageGenerationOptions, token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }>;
}
