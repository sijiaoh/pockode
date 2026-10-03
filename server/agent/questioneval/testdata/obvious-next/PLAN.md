# Plan: slugify

1. Add `slugify(text)` to `textutil.py`: lowercase, replace every run of
   non-alphanumeric characters with a single `-`, strip leading and trailing `-`.
2. Add tests for it in `test_textutil.py`, in the same style as the existing ones.
3. Document it in the README's "Functions" list.
