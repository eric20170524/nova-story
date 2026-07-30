import { db } from './backend/src/db/database';
import { LLMService } from './backend/src/services/llm';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const projectId = 2;
  const chapters = await db.all('SELECT * FROM chapter WHERE project_id = ? ORDER BY "index"', projectId);
  
  if (chapters.length === 0) {
    console.log("No chapters found.");
    return;
  }
  
  // 1. Extract Characters
  console.log("Extracting characters with delay to avoid quota...");
  const allProfiles = new Map();
  for (const chapter of chapters) {
    if (!chapter.content) continue;
    
    // Check if characters already exist for this project to save quota
    const existing = await db.all('SELECT * FROM character WHERE project_id = ?', projectId);
    if (existing.length > 5) {
       console.log("Characters seem to exist already. Skipping extraction.");
       for (const char of existing) allProfiles.set(char.name, char);
       break;
    }

    console.log(`Extracting from chapter: ${chapter.title}`);
    try {
      const profiles = await LLMService.extractCharacterProfiles(chapter.content);
      for (const p of profiles) {
        if (!allProfiles.has(p.name)) {
          allProfiles.set(p.name, p);
        }
      }
      console.log(`Waiting 15 seconds for quota...`);
      await delay(15000);
    } catch (e) {
      console.error(`Error extracting characters from ${chapter.title}`, e);
    }
  }
  
  if (allProfiles.size > 0) {
      console.log(`Found ${allProfiles.size} unique characters. Saving to DB...`);
      for (const profile of allProfiles.values()) {
        const existing = await db.get('SELECT * FROM character WHERE project_id = ? AND name = ?', projectId, profile.name);
        if (!existing) {
          await db.run(
            'INSERT INTO character (project_id, name, role, description) VALUES (?, ?, ?, ?)',
            projectId, profile.name, profile.role, profile.description
          );
        }
      }
  }
  
  // 2. Generate Timeline (Scenes)
  console.log("Generating scenes...");
  const characters = await db.all('SELECT * FROM character WHERE project_id = ?', projectId);
  const characterProfiles = characters.map(c => `${c.name} (${c.role}): ${c.description}`).join('\n');
  
  for (const chapter of chapters) {
    if (!chapter.content) continue;
    const existingScenes = await db.all('SELECT * FROM scene WHERE chapter_id = ?', chapter.id);
    if (existingScenes.length > 0) {
      console.log(`Scenes already exist for chapter ${chapter.title}. Skipping.`);
      continue;
    }
    
    console.log(`Generating scenes for chapter: ${chapter.title}`);
    try {
      const shots = await LLMService.generateTimeline(chapter.content, characterProfiles, "nine_shot_coverage");
      
      let index = 0;
      for (const shot of shots) {
        await db.run(
          `INSERT INTO scene (
            chapter_id, "index", shot_type, camera_movement, camera_angle, 
            visual_prompt, audio_prompt, dialogue, duration
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          chapter.id, index++, shot.shot_type, shot.camera_movement, shot.camera_angle,
          shot.visual_prompt, shot.audio_prompt, shot.dialogue, shot.duration
        );
      }
      console.log(`Waiting 15 seconds for quota...`);
      await delay(15000);
    } catch (e) {
      console.error(`Error generating scenes for ${chapter.title}`, e);
    }
  }
  
  console.log("Done extracting characters and scenes.");
}

main().catch(console.error);
