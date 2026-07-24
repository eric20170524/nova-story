import unittest

from app.services.prompts import Prompts


class CinematicGridPromptTests(unittest.TestCase):
    def test_builds_final_nine_panel_prompt_without_llm_meta_instructions(self):
        prompt = Prompts.build_cinematic_grid_image_prompt(
            "A wounded swordsman kneels below a snowy fortress. --no cars, text"
        )

        self.assertIn("exactly 3 rows and exactly 3 columns", prompt)
        self.assertIn("Panel 1 top-left", prompt)
        self.assertIn("Panel 9 bottom-right", prompt)
        self.assertIn("A wounded swordsman kneels below a snowy fortress.", prompt)
        self.assertNotIn("--no", prompt)
        self.assertNotIn("cars, text", prompt)
        self.assertNotIn("Do not create the image", prompt)

    def test_rejects_empty_scene_prompt(self):
        with self.assertRaises(ValueError):
            Prompts.build_cinematic_grid_image_prompt("   ")


if __name__ == "__main__":
    unittest.main()
