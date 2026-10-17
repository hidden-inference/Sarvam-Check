# Sarvam Check

AI grading assistant for TAs and teachers. It grades handwritten answer sheets against a marking scheme.

1. **Marking scheme**: add questions, the points each answer should contain, and the marks for each point.
2. **Upload**: drag and drop PDFs or images, or a ZIP of them for a whole batch. The file name is used as the student name.
3. **Results**: Sarvam Vision (Document AI) reads the handwriting. `sarvam-105b` matches each answer to its question and awards marks per rubric point. Download the scores as Excel or CSV.

## Run

```bash
python -m pip install -r requirements.txt
# put your key in .env  ->  SARVAM_API_KEY=...
python app.py
```

Open http://localhost:5000
