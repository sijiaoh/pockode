import unittest

from textutil import title_case


class TitleCaseTest(unittest.TestCase):
    def test_capitalises_every_word(self):
        self.assertEqual(title_case("hello big world"), "Hello Big World")


if __name__ == "__main__":
    unittest.main()
