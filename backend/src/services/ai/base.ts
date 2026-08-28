import { z } from 'zod';

export type StructuredGenOptions = {
  temperature?: number;
  maxTokens?: number;
  systemInstruction?: string;
};

export type ImageGenerationOptions = {
  width: number;
  height: number;
  aspectRatio: '3:4' | '4:3' | '1:1';
  imageSize: '512' | '1K' | '2K';
};

export interface AIProvider {
    generateText(prompt: string, systemInstruction?: string): Promise<string>;

    // In Node.js with Zod, we pass the ZodSchema to be parsed instead of a Pydantic Model
    generateStructured<T>(
      prompt: string,
      responseSchema: z.ZodSchema<T>,
      systemInstruction?: string,
      options?: StructuredGenOptions
    ): Promise<T>;

    generateImage(prompt: string, options?: ImageGenerationOptions, token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }>;
}
