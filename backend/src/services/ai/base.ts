import { z } from 'zod';

export interface AIProvider {
    generateText(prompt: string, systemInstruction?: string): Promise<string>;

    // In Node.js with Zod, we pass the ZodSchema to be parsed instead of a Pydantic Model
    generateStructured<T>(prompt: string, responseSchema: z.ZodSchema<T>, systemInstruction?: string): Promise<T>;

    generateImage(prompt: string, size?: string, token?: string): Promise<{ url?: string; b64_json?: string; data?: Buffer; error?: string }>;
}
