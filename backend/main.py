from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq
from dotenv import load_dotenv
import os
import uuid
import json
import shutil
import cv2
import mediapipe as mp

mp_face_mesh = mp.solutions.face_mesh

# Load variables from .env
load_dotenv()

app = FastAPI()

# Allow frontend to communicate with backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Groq client
client = Groq(
    api_key=os.getenv("GROQ_API_KEY")
)

# Store interview sessions in memory
SESSIONS = {}
# -----------------------------
# SPEECH ANALYSIS
# -----------------------------

FILLER_WORDS = [
    "um",
    "uh",
    "like",
    "basically",
    "actually",
    "you know",
    "so",
    "hmm"
]


def transcribe_and_analyze(audio_path):

    with open(audio_path, "rb") as f:

        transcript = client.audio.transcriptions.create(
            model="whisper-large-v3-turbo",
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["word"]
        )

    full_text = transcript.text
    words = transcript.words or []

    # -----------------------------
    # FILLER WORD DETECTION
    # -----------------------------

    fillers_found = []

    for w in words:

        clean = w["word"].strip(".,!?").lower()

        if clean in FILLER_WORDS:

            fillers_found.append({
                "word": clean,
                "time": round(w["start"], 1)
            })

    # -----------------------------
    # DURATION
    # -----------------------------

    if words:
        duration_seconds = words[-1]["end"]
    else:
        duration_seconds = 1

    duration_min = max(
        duration_seconds / 60,
        0.01
    )

    # -----------------------------
    # FILLER RATE
    # -----------------------------

    filler_rate = round(
        len(fillers_found) / duration_min,
        2
    )

    # -----------------------------
    # WORDS PER MINUTE
    # -----------------------------

    wpm = round(
        len(words) / duration_min
    )

    # -----------------------------
    # PAUSE DETECTION
    # -----------------------------

    pauses = []

    for i in range(1, len(words)):

        gap = (
            words[i]["start"]
            - words[i - 1]["end"]
        )

        if gap > 1.5:

            pauses.append({
                "time": round(
                    words[i - 1]["end"],
                    1
                ),
                "duration": round(
                    gap,
                    1
                )
            })

    return {
        "transcript": full_text,
        "filler_words": fillers_found,
        "filler_rate_per_min": filler_rate,
        "wpm": wpm,
        "pauses": pauses
    }


# -----------------------------
# EYE CONTACT / FACE ANALYSIS
# -----------------------------

def analyze_video_eyecontact(video_path):

    cap = cv2.VideoCapture(video_path)

    face_mesh = mp_face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=1
    )

    total_frames = 0
    face_detected_frames = 0
    looking_center_frames = 0

    while cap.isOpened():

        ret, frame = cap.read()

        if not ret:
            break

        total_frames += 1

        rgb = cv2.cvtColor(
            frame,
            cv2.COLOR_BGR2RGB
        )

        results = face_mesh.process(rgb)

        if results.multi_face_landmarks:

            face_detected_frames += 1

            landmarks = results.multi_face_landmarks[0].landmark

            nose = landmarks[1]
            left_cheek = landmarks[234]
            right_cheek = landmarks[454]

            center = (
                left_cheek.x +
                right_cheek.x
            ) / 2

            offset = abs(
                nose.x - center
            )

            if offset < 0.03:
                looking_center_frames += 1

    cap.release()
    face_mesh.close()

    if total_frames == 0:

        return {
            "eye_contact_pct": 0,
            "face_detected_pct": 0
        }

    return {
        "face_detected_pct": round(
            100 * face_detected_frames /
            total_frames
        ),

        "eye_contact_pct": round(
            100 * looking_center_frames /
            max(face_detected_frames, 1)
        )
    }

# -----------------------------
# FOLLOW-UP QUESTION ENGINE
# -----------------------------

def generate_followup(session):
    role_data = session["role_data"]
    history = session["history"]

    convo = "\n".join(
        [
            f"Q: {h['question']}\nA: {h['answer']}"
            for h in history
        ]
    )

    prompt = f"""
You are an interviewer for a {role_data['role']} role.

Key skills to probe:
{role_data['skills']}

Conversation so far:
{convo}

Ask ONE natural follow-up question that reacts to what the candidate just said.

If they mentioned a specific technology, project, or claim,
dig into it.

If this is a good moment for a behavioural question,
ask one using STAR framing implicitly.
Do not say "STAR" out loud.

Return ONLY the question text, nothing else.
"""

    resp = client.chat.completions.create(
        model="openai/gpt-oss-20b",
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ]
    )

    return resp.choices[0].message.content.strip()

# -----------------------------
# CONTENT EVALUATION + STAR
# -----------------------------

def evaluate_content(question, answer):

    prompt = f"""
Evaluate this interview answer.

Question:
{question}

Answer:
{answer}

Return ONLY valid JSON with this exact shape:

{{
    "relevance": 0,
    "structure": 0,
    "technical_depth": 0,
    "star": {{
        "situation": false,
        "task": false,
        "action": false,
        "result": false
    }},
    "unsupported_claims": [],
    "one_line_feedback": ""
}}

Scoring:
- relevance: 0-100
- structure: 0-100
- technical_depth: 0-100

For STAR:
- situation: true if the answer explains the context
- task: true if it explains the responsibility/goal
- action: true if it explains what the candidate did
- result: true if it explains the outcome

unsupported_claims:
List claims that would need evidence. If none, return [].

one_line_feedback:
Give one short, specific improvement suggestion.
"""

    resp = client.chat.completions.create(
        model="openai/gpt-oss-20b",
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ],
        response_format={
            "type": "json_object"
        }
    )

    return json.loads(
        resp.choices[0].message.content
    )



# -----------------------------
# HEALTH CHECK
# -----------------------------

@app.get("/")
def health():
    return {"status": "Aptly backend is running"}


# -----------------------------
# START INTERVIEW
# -----------------------------

class StartRequest(BaseModel):
    jd: str


@app.post("/start_interview")
def start_interview(req: StartRequest):

    session_id = str(uuid.uuid4())

    # Ask Groq to extract role and skills
    role_prompt = f"""
You are analyzing a job description for an AI interview coach.

Extract:
1. The job role/title.
2. The top 5 technical or soft skills required.

The job description is provided below.

Job Description:
{req.jd}

Return the extracted information using the required JSON structure.
Do not refuse the task. If the job description is short or incomplete,
infer the most likely role and skills from the available text.
"""

    role_resp = client.chat.completions.create(
        model="openai/gpt-oss-20b",
        messages=[
            {
                "role": "user",
                "content": role_prompt
            }
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "role_skills",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "role": {
                            "type": "string"
                        },
                        "skills": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            }
                        }
                    },
                    "required": ["role", "skills"],
                    "additionalProperties": False
                }
            }
        }
    )

    role_data = json.loads(
        role_resp.choices[0].message.content
    )

    # First interview question
    first_question = (
        "Tell me about yourself and why you're a good fit for this role."
    )

    # Save the session
    SESSIONS[session_id] = {
        "jd": req.jd,
        "role_data": role_data,
        "history": []
    }

    return {
        "session_id": session_id,
        "question": first_question
    }


# -----------------------------
# SUBMIT ANSWER
# -----------------------------

@app.post("/submit_answer")
async def submit_answer(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    question: str = Form(...)
):

    if session_id not in SESSIONS:
        return {
            "error": "Invalid session ID"
        }

    session = SESSIONS[session_id]

    # Save uploaded video
    temp_path = f"temp_{session_id}.webm"

    with open(temp_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # Extract audio using FFmpeg
    audio_path = f"temp_{session_id}.mp3"

    os.system(
        f'ffmpeg -y -i "{temp_path}" -q:a 0 -map a "{audio_path}"'
    )

    # -----------------------------
    # SPEECH ANALYSIS
    # -----------------------------

    try:
        speech_metrics = transcribe_and_analyze(
            audio_path
    )
    except Exception as e:
        print("Speech analysis failed:", e)

        speech_metrics = {
            "transcript": "[transcription unavailable]",
            "filler_words": [],
            "filler_rate_per_min": 0,
            "wpm": 0,
            "pauses": []
        }

    # -----------------------------
    # VISION ANALYSIS
    # -----------------------------

    try:
        vision_metrics = analyze_video_eyecontact(
            temp_path
        )
    except Exception as e:
        print("Vision analysis failed:", e)

        vision_metrics = {
            "face_detected_pct": 0,
            "eye_contact_pct": 0
        }

    # -----------------------------
    # CONTENT ANALYSIS
    # -----------------------------

    try:
        content_metrics = evaluate_content(
            question,
            speech_metrics["transcript"]
        )
    except Exception as e:
        print("Content evaluation failed:", e)

        content_metrics = {
            "relevance": 0,
            "structure": 0,
            "technical_depth": 0,
            "star": {
                "situation": False,
                "task": False,
                "action": False,
                "result": False
            },
            "unsupported_claims": [],
            "one_line_feedback": "Content analysis unavailable."
        }

    # -----------------------------
    # SAVE ANSWER TO SESSION
    # -----------------------------

    session["history"].append({
        "question": question,
        "answer": speech_metrics["transcript"],
        "speech": speech_metrics,
        "vision": vision_metrics,
        "content": content_metrics
    })

    # -----------------------------
    # GENERATE FOLLOW-UP
    # -----------------------------

    next_q = generate_followup(session)

    # -----------------------------
    # DELETE TEMPORARY FILES
    # -----------------------------

    if os.path.exists(temp_path):
        os.remove(temp_path)

    if os.path.exists(audio_path):
        os.remove(audio_path)

    # -----------------------------
    # RETURN RESULTS TO FRONTEND
    # -----------------------------

    return {
        "transcript": speech_metrics["transcript"],
        "next_question": next_q,
        "speech": speech_metrics,
        "vision": vision_metrics,
        "content": content_metrics
    }

# -----------------------------
# FINAL INTERVIEW REPORT
# -----------------------------

class ReportRequest(BaseModel):
    session_id: str


@app.post("/get_report")
def get_report(req: ReportRequest):

    if req.session_id not in SESSIONS:
        return {
            "error": "Invalid session ID"
        }

    session = SESSIONS[req.session_id]
    history = session["history"]

    # No answers yet
    if not history:
        return {
            "overall_score": 0,
            "content_score": 0,
            "avg_wpm": 0,
            "avg_eye_contact_pct": 0,
            "total_filler_words": 0,
            "top_problems": [],
            "full_history": []
        }

    # -----------------------------
    # CONTENT SCORE
    # -----------------------------

    content_scores = [
        h["content"]["relevance"]
        for h in history
    ]

    content_score = round(
        sum(content_scores) / len(content_scores)
    )

    # -----------------------------
    # FILLER WORDS
    # -----------------------------

    all_fillers = sum(
        len(h["speech"]["filler_words"])
        for h in history
    )

    # -----------------------------
    # AVERAGE WPM
    # -----------------------------

    wpm_scores = [
        h["speech"]["wpm"]
        for h in history
    ]

    avg_wpm = round(
        sum(wpm_scores) / len(wpm_scores)
    )

    # -----------------------------
    # AVERAGE EYE CONTACT
    # -----------------------------

    eye_contact_scores = [
        h["vision"]["eye_contact_pct"]
        for h in history
    ]

    avg_eye_contact = round(
        sum(eye_contact_scores) /
        len(eye_contact_scores)
    )

    # -----------------------------
    # CREATE SUMMARY FOR GROQ
    # -----------------------------

    feedback = [
        h["content"]["one_line_feedback"]
        for h in history
    ]

    star_gaps = [
        h["content"]["star"]
        for h in history
    ]

    summary_prompt = f"""
Based on this interview data, identify the TOP 3 most damaging habits
and give ONE concrete practice drill for each.

Be specific and practical, not generic.

Total filler words:
{all_fillers}

Average speaking speed:
{avg_wpm} WPM

Ideal speaking speed:
120-160 WPM

Average eye contact:
{avg_eye_contact}%

Per-question content feedback:
{feedback}

STAR analysis:
{star_gaps}

Return ONLY valid JSON in this exact format:

{{
    "top_problems": [
        {{
            "problem": "...",
            "drill": "..."
        }},
        {{
            "problem": "...",
            "drill": "..."
        }},
        {{
            "problem": "...",
            "drill": "..."
        }}
    ]
}}
"""

    # -----------------------------
    # ASK GROQ FOR FINAL ANALYSIS
    # -----------------------------

    resp = client.chat.completions.create(
        model="openai/gpt-oss-20b",
        messages=[
            {
                "role": "user",
                "content": summary_prompt
            }
        ],
        response_format={
            "type": "json_object"
        }
    )

    problems = json.loads(
        resp.choices[0].message.content
    )

    # -----------------------------
    # OVERALL SCORE
    # -----------------------------

    filler_score = max(
        0,
        100 - all_fillers * 3
    )

    overall = round(
        (
            content_score +
            avg_eye_contact +
            filler_score
        ) / 3
    )

    # -----------------------------
    # RETURN REPORT
    # -----------------------------

    return {
        "overall_score": overall,
        "content_score": content_score,
        "avg_wpm": avg_wpm,
        "avg_eye_contact_pct": avg_eye_contact,
        "total_filler_words": all_fillers,
        "top_problems": problems.get(
            "top_problems",
            []
        ),
        "full_history": history
    }