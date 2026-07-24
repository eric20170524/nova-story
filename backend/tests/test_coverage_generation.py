import unittest
from unittest.mock import patch, MagicMock
from app.services.llm import LLMService


class CoverageGenerationTests(unittest.TestCase):

    @patch("app.services.llm.LLMService._generate_structured_with_retry")
    def test_single_scene_coverage_fallback_returns_nine_shots(self, mock_generate):
        mock_generate.return_value = None

        scene_data = {
            "visual_prompt": "The warrior stands on the cliff, holding a glowing sword in the heavy rain.",
            "dialogue": "Warrior: I will not fall today.",
            "duration": 3.0
        }
        
        shots = LLMService.generate_scene_coverage(scene_data)
        self.assertEqual(len(shots), 9)
        self.assertEqual(shots[0]["slot"], 1)
        self.assertEqual(shots[0]["shot_type"], "Extreme Long Shot")
        self.assertEqual(shots[7]["camera_angle"], "Low Angle")
        self.assertEqual(shots[8]["camera_angle"], "High Angle")
        for shot in shots:
            self.assertIn("The warrior stands on the cliff", shot["visual_prompt"])

    @patch("app.services.llm.LLMService._generate_structured_with_retry")
    def test_single_scene_coverage_validation_pass(self, mock_generate):
        mock_shots = [
            {
                "id": i,
                "shot_type": f"ShotType_{i}",
                "camera_movement": "Static",
                "camera_angle": "Eye-level",
                "visual_prompt": f"Detailed prompt for slot {i}"
            }
            for i in range(1, 10)
        ]
        mock_response = MagicMock()
        mock_response.shots = [MagicMock(**s, model_dump=lambda s=s: s) for s in mock_shots]
        mock_generate.return_value = mock_response

        scene_data = {"visual_prompt": "Hero in desert"}
        shots = LLMService.generate_scene_coverage(scene_data)
        self.assertEqual(len(shots), 9)
        self.assertEqual(shots[0]["slot"], 1)


if __name__ == "__main__":
    unittest.main()
