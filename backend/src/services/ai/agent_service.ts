import { db } from '../../db/database';
import { AgentRequest, AgentResponse } from '../../schemas/agent';
import { logger } from '../../core/logging';
import { LLMService } from '../llm';
import type { AIProvider } from './base';

export class AgentService {
    private llm: AIProvider;

    constructor() {
        this.llm = LLMService.getProvider();
    }

    async processRequest(request: AgentRequest): Promise<AgentResponse> {
        try {
            const contextStr = await this.buildContext(request);
            const language = request.context.language || 'zh';
            const systemPrompt = this.buildSystemPrompt(contextStr, language);

            let messagesStr = "";
            for (const msg of request.history) {
                const role = msg.role === 'user' ? 'User' : 'Agent';
                messagesStr += `${role}: ${msg.content}\n`;
            }
            messagesStr += `User: ${request.message}\nAgent:`;

            const rawResponse = await this.llm.generateText(messagesStr, systemPrompt);
            const agentResponse = this.parseResponse(rawResponse);

            if (agentResponse.action) {
                const toolResult = await this.executeTool(agentResponse.action, request);
                if (toolResult) {
                    agentResponse.response += `\n\n[Tool Output]: ${toolResult}`;
                }
            }

            return agentResponse;
        } catch (error) {
            logger.error(`Agent processing failed: ${error}`);
            return {
                thought: "System Error",
                response: "I encountered an internal error while processing your request.",
            };
        }
    }

    private async buildContext(request: AgentRequest): Promise<string> {
        const ctx = request.context;
        const contextParts = [];

        if (ctx.project_id) {
            const chars = await db.all('SELECT name FROM character WHERE project_id = ?', ctx.project_id);
            if (chars && chars.length > 0) {
                const charList = chars.map(c => c.name).join(', ');
                contextParts.push(`Project Characters: ${charList}`);
            }
        }

        if (ctx.chapter_id) {
            const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', ctx.chapter_id);
            if (chapter) {
                contextParts.push(`Current Chapter: ${chapter.title}`);
                if (chapter.summary) contextParts.push(`Chapter Summary: ${chapter.summary}`);
                if (chapter.content) {
                    const snippet = chapter.content.length > 500 ? chapter.content.substring(0, 500) + "..." : chapter.content;
                    contextParts.push(`Chapter Start: ${snippet}`);
                }
            }
        }

        return contextParts.join('\n');
    }

    private buildSystemPrompt(contextStr: string, language: string = 'zh'): string {
        const langInstruction = language === 'zh' ? "You MUST respond in CHINESE (Simplified)." : "You MUST respond in ENGLISH.";
        return `You are the 'Director's Assistant' in NovaStory, an AI-powered creative writing and directing platform.
Your goal is to assist the user in directing their story, managing characters, and visualizing scenes.

LANGUAGE:
${langInstruction}

CONTEXT:
${contextStr}

AVAILABLE TOOLS:
1. analyze_chapter(chapter_id: str) - Analyze the current chapter for mood, pacing, and characters.
2. generate_timeline(chapter_id: str) - Automatically break down the chapter into scenes (storyboard).
3. get_character_info(name: str) - Get details about a specific character.
4. update_character_info(name: str, description: str, visual_tags: dict) - Update a character's traits.

RESPONSE FORMAT:
You must output a JSON object with the following structure:
{
  "thought": "Your internal reasoning process...",
  "response": "Your natural language response to the user...",
  "action": { "tool_name": "...", "arguments": {...}, "reason": "..." } (OPTIONAL)
}

Do not include markdown formatting (like \`\`\`json) in your output. Just the raw JSON.
If no tool is needed, set "action" to null.
`;
    }

    private parseResponse(rawText: string): AgentResponse {
        try {
            const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanText) as AgentResponse;
        } catch (error) {
            return {
                thought: "Failed to parse JSON",
                response: rawText
            };
        }
    }

    private async executeTool(action: any, request: AgentRequest): Promise<string> {
        try {
            if (action.tool_name === "analyze_chapter") {
                const chapterId = action.arguments.chapter_id || request.context.chapter_id;
                if (!chapterId) return "Error: No chapter ID provided.";

                const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapterId);
                if (!chapter || !chapter.content) return "Error: Chapter not found or empty.";

                // Note: LLMService analysis is skipped here for brevity in Phase 4 porting, but we can easily call a prompt
                return `Analysis Result for ${chapter.title}`;
            }

            if (action.tool_name === "generate_timeline") {
                const chapterId = action.arguments.chapter_id || request.context.chapter_id;
                if (!chapterId) return "Error: No chapter ID provided.";

                const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapterId);
                if (!chapter || !chapter.content) return "Error: Chapter not found or empty.";

                const timelineData = await LLMService.generateTimeline(chapter.content);

                let savedCount = 0;
                for (let i = 0; i < timelineData.length; i++) {
                    const sceneData = timelineData[i];
                    await db.run(`
                        INSERT INTO scene (
                            chapter_id, \`index\`, visual_prompt, audio_prompt, duration, shot_type, camera_movement, camera_angle, asset_status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')
                    `,
                        chapterId, i,
                        sceneData.visual_prompt || "",
                        sceneData.audio_prompt || "",
                        sceneData.duration || 3.0,
                        sceneData.shot_type || "medium",
                        sceneData.camera_movement || "static",
                        sceneData.camera_angle || "eye_level"
                    );
                    savedCount++;
                }

                return `Successfully generated and saved ${savedCount} scenes for chapter '${chapter.title}'.`;
            }

            if (action.tool_name === "get_character_info") {
                const name = action.arguments.name;
                const char = await db.get('SELECT * FROM character WHERE name = ? AND project_id = ?', name, request.context.project_id);
                if (char) {
                    return `Name: ${char.name}\nRole: ${char.role}\nDescription: ${char.description}\nTags: ${char.visual_tags}`;
                }
                return "Character not found.";
            }

            if (action.tool_name === "update_character_info") {
                const name = action.arguments.name;
                const desc = action.arguments.description;
                const tags = action.arguments.visual_tags;

                const char = await db.get('SELECT * FROM character WHERE name = ? AND project_id = ?', name, request.context.project_id);
                if (char) {
                    const updates = [];
                    const params = [];
                    if (desc) { updates.push('description = ?'); params.push(desc); }
                    if (tags) { updates.push('visual_tags = ?'); params.push(typeof tags === 'string' ? tags : JSON.stringify(tags)); }

                    if (updates.length > 0) {
                        params.push(char.id);
                        await db.run(`UPDATE character SET ${updates.join(', ')} WHERE id = ?`, ...params);
                        return `Updated character '${name}'.`;
                    }
                }
                return "Character not found.";
            }

            return "Unknown tool.";
        } catch (error: any) {
            logger.error(`Tool execution failed: ${error}`);
            return `Tool execution failed: ${error.message}`;
        }
    }
}
