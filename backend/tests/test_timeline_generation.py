import unittest
from unittest.mock import patch, MagicMock
from app.services.llm import LLMService
from app.schemas.llm import TimelineResponse, TimelineShot


class TimelineGenerationTests(unittest.TestCase):

    def test_validate_nine_shot_coverage_pass(self):
        valid_shots = [
            {"id": i, "shot_type": "Shot", "visual_prompt": f"Prompt {i}"}
            for i in range(1, 10)
        ]
        self.assertTrue(LLMService._validate_nine_shot_coverage(valid_shots))

    def test_validate_nine_shot_coverage_fails_wrong_count(self):
        invalid_shots = [
            {"id": i, "shot_type": "Shot", "visual_prompt": f"Prompt {i}"}
            for i in range(1, 8)
        ]
        self.assertFalse(LLMService._validate_nine_shot_coverage(invalid_shots))

    @patch("app.services.llm.LLMService._generate_structured_with_retry")
    def test_generate_timeline_narrative_mode(self, mock_generate):
        mock_response = TimelineResponse(shots=[
            TimelineShot(id=1, shot_type="Medium Shot", visual_prompt="Hero stands in forest"),
            TimelineShot(id=2, shot_type="Close-Up", visual_prompt="Hero looking ahead")
        ])
        mock_generate.return_value = mock_response

        shots = LLMService.generate_timeline("Hero in forest", mode="narrative")
        self.assertEqual(len(shots), 2)
        self.assertEqual(shots[0]["shot_type"], "Medium Shot")


if __name__ == "__main__":
    unittest.main()
