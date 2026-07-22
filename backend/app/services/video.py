import os
import random
from typing import List, Optional, Dict, Any
from pathlib import Path
import tempfile

from moviepy.editor import (
    VideoFileClip,
    AudioFileClip,
    ImageClip,
    CompositeVideoClip,
    concatenate_videoclips,
    TextClip,
    ColorClip,
    CompositeAudioClip,
    afx,
    vfx
)
import numpy as np

from app.core.config import settings
# Assuming we might need logging
import logging

logger = logging.getLogger(__name__)

# Constants
FPS = 30
TRANSITION_DURATION = 0.5

class VideoService:
    def __init__(self):
        self.temp_dir = Path(tempfile.gettempdir()) / "novastory_video_processing"
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def _apply_zoom_effect(self, clip, duration, zoom_ratio=0.04):
        """
        Applies a slow zoom effect (Ken Burns) to an image clip.
        zoom_ratio: Percentage to zoom over the duration (0.04 = 4%)
        """
        # Resize to start at 100% and zoom to 100% + zoom_ratio
        # We assume the clip is already resized to fit the screen or larger
        return clip.resize(lambda t: 1 + (zoom_ratio * t / duration))

    def _process_scene(self, scene: Dict[str, Any], width: int, height: int) -> Optional[VideoFileClip]:
        """
        Converts a single scene dictionary into a MoviePy VideoClip.
        Scene dict expectation:
        {
            "asset_url": "path/to/image.png" or "path/to/video.mp4",
            "audio_url": "path/to/audio.mp3" (optional),
            "duration": 5.0,
            "dialogue": "Subtitle text" (optional)
        }
        """
        asset_path = scene.get("asset_url")
        audio_path = scene.get("audio_url")
        duration = float(scene.get("duration", 3.0))
        
        if not asset_path or not os.path.exists(asset_path):
            logger.warning(f"Asset not found for scene: {asset_path}")
            # Return a black clip as placeholder?
            return ColorClip(size=(width, height), color=(0,0,0), duration=duration)

        try:
            # Determine if asset is image or video
            ext = os.path.splitext(asset_path)[1].lower()
            if ext in ['.jpg', '.jpeg', '.png', '.webp']:
                # Image processing
                clip = ImageClip(asset_path).set_duration(duration)
                
                # Resize to cover (maintain aspect ratio, crop excess)
                # First resize so the smallest dimension matches target
                w, h = clip.size
                scale = max(width / w, height / h)
                clip = clip.resize(scale)
                clip = clip.crop(x_center=clip.w/2, y_center=clip.h/2, width=width, height=height)
                
                # Apply Zoom
                clip = self._apply_zoom_effect(clip, duration)
                
            elif ext in ['.mp4', '.mov', '.avi', '.webm']:
                # Video processing
                clip = VideoFileClip(asset_path)
                
                # Loop or trim
                if clip.duration < duration:
                    clip = clip.loop(duration=duration)
                else:
                    clip = clip.subclip(0, duration)
                
                # Resize/Crop
                w, h = clip.size
                scale = max(width / w, height / h)
                clip = clip.resize(scale)
                clip = clip.crop(x_center=clip.w/2, y_center=clip.h/2, width=width, height=height)
                
                # Mute original video audio if we are replacing it
                clip = clip.without_audio()
            else:
                logger.warning(f"Unsupported asset type: {ext}")
                return ColorClip(size=(width, height), color=(50,50,50), duration=duration)

            # Center position just in case
            clip = clip.set_position("center")

            # Attach Audio
            if audio_path and os.path.exists(audio_path):
                audio = AudioFileClip(audio_path)
                # If audio is longer than visual duration, visuals govern (for now) 
                # OR we extend visual? Usually timeline engine decides duration.
                # Here we assume 'duration' passed in IS the correct duration.
                if audio.duration > duration:
                    audio = audio.subclip(0, duration)
                clip = clip.set_audio(audio)
            
            # TODO: Add Text/Subtitle Overlay here if needed
            
            return clip

        except Exception as e:
            logger.error(f"Error processing scene asset {asset_path}: {e}")
            return ColorClip(size=(width, height), color=(255,0,0), duration=duration)


    def render_timeline(
        self, 
        timeline: List[Dict[str, Any]], 
        output_path: str, 
        width: int = 1920, 
        height: int = 1080,
        bgm_url: Optional[str] = None
    ) -> str:
        """
        Renders a full video from a list of scenes.
        """
        logger.info(f"Starting rendering for {len(timeline)} scenes. Target: {output_path}")
        
        clips = []
        for i, scene in enumerate(timeline):
            logger.info(f"Processing scene {i+1}...")
            clip = self._process_scene(scene, width, height)
            if clip:
                # Add simple fade in/out for smoother transitions?
                # For now, let's just do hard cuts or simple crossfade if supported
                if i > 0: 
                    clip = clip.crossfadein(0.5) 
                clips.append(clip)

        if not clips:
            raise ValueError("No valid clips generated from timeline")

        # Concatenate
        # method='compose' is slower but handles overlapping transitions (crossfade)
        final_video = concatenate_videoclips(clips, method="compose", padding=-0.5) 

        # Add Background Music (Global)
        if bgm_url and os.path.exists(bgm_url):
            try:
                bgm = AudioFileClip(bgm_url)
                # Loop BGM to match video length
                bgm = afx.audio_loop(bgm, duration=final_video.duration)
                # Lower volume so voiceovers are heard
                bgm = bgm.volumex(0.2) 
                
                if final_video.audio:
                    # Mix BGM with existing scene audio
                    final_audio = CompositeAudioClip([final_video.audio, bgm])
                    final_video = final_video.set_audio(final_audio)
                else:
                    final_video = final_video.set_audio(bgm)
            except Exception as e:
                logger.error(f"Failed to add BGM: {e}")

        # Write Output
        # Use a temp file first to avoid corruption? or write directly.
        # Ensure directory exists
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        logger.info("Writing video file...")
        final_video.write_videofile(
            output_path, 
            fps=FPS, 
            codec="libx264", 
            audio_codec="aac",
            threads=4,
            preset='medium',
            logger=None # Disable moviepy's internal logger to keep stdout clean? or 'bar'
        )
        
        # Cleanup clips to release resources
        for clip in clips:
            try:
                clip.close()
                if clip.audio: clip.audio.close()
            except:
                pass
        final_video.close()
        
        logger.info(f"Rendering complete: {output_path}")
        return output_path

video_service = VideoService()
