/* ==========================================================================
   Aptly — AI Interview Coach
   script.js
   ========================================================================== */

const API_BASE = "http://localhost:8000";

/* ---------- Session state ---------- */
let sessionId = null;
let currentQuestion = "";
let questionNumber = 0;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let isBusy = false; // guards against duplicate/overlapping requests

/* ---------- Cached elements from the existing HTML ---------- */
const screenHome = document.getElementById("screen-home");
const screenInterview = document.getElementById("screen-interview");
const screenReport = document.getElementById("screen-report");
const jdInput = document.getElementById("jd-input");
const startBtn = document.querySelector('#screen-home button[onclick="startInterview()"]');
const finishBtn = document.querySelector('#screen-interview button[onclick="finishInterview()"]');
const questionEl = document.getElementById("question");
const webcamEl = document.getElementById("webcam");
const recordBtn = document.getElementById("record-btn");
const reportOutput = document.getElementById("report-output");

/* ==========================================================================
   Dynamic UI elements (created in JS so index.html stays untouched)
   ========================================================================== */

let videoWrap, recIndicator, metaRow, counterEl, statusEl, statusDot, analyzingEl;

function buildDynamicInterviewUI() {
  // Wrap the existing webcam element in a styled frame + REC indicator
  videoWrap = document.createElement("div");
  videoWrap.className = "aptly-video-wrap";
  webcamEl.parentNode.insertBefore(videoWrap, webcamEl);
  videoWrap.appendChild(webcamEl);

  recIndicator = document.createElement("div");
  recIndicator.className = "aptly-rec";
  recIndicator.innerHTML = '<span class="aptly-rec-dot"></span><span>REC</span>';
  videoWrap.appendChild(recIndicator);

  // Question counter + status row, placed right above the question card
  metaRow = document.createElement("div");
  metaRow.className = "aptly-meta-row";

  counterEl = document.createElement("div");
  counterEl.className = "aptly-counter";
  counterEl.textContent = "Question 1";

  statusEl = document.createElement("div");
  statusEl.className = "aptly-status";
  statusDot = document.createElement("span");
  statusDot.className = "aptly-status-dot";
  const statusLabel = document.createElement("span");
  statusLabel.textContent = "Ready";
  statusEl.appendChild(statusDot);
  statusEl.appendChild(statusLabel);
  statusEl._label = statusLabel;

  metaRow.appendChild(counterEl);
  metaRow.appendChild(statusEl);
  questionEl.parentNode.insertBefore(metaRow, questionEl);

  // Analyzing indicator, shown/hidden below the question card
  analyzingEl = document.createElement("div");
  analyzingEl.className = "aptly-analyzing hidden";
  analyzingEl.innerHTML = '<span class="aptly-spinner-sm"></span><span>Analyzing your answer...</span>';
  questionEl.parentNode.insertBefore(analyzingEl, questionEl.nextSibling);
}

function updateCounter() {
  if (!counterEl) return;
  counterEl.textContent = `Question ${questionNumber}`;
}

function setStatus(label, active = false) {
  if (!statusEl) return;
  statusEl._label.textContent = label;
  statusDot.classList.toggle("is-active", active);
}

function showRecIndicator(show) {
  if (!recIndicator) return;
  recIndicator.classList.toggle("is-visible", show);
}

function showAnalyzing(show) {
  if (!analyzingEl) return;
  analyzingEl.classList.toggle("hidden", !show);
}

/* ==========================================================================
   Small helpers
   ========================================================================== */

function showScreen(screen) {
  [screenHome, screenInterview, screenReport].forEach((s) => s.classList.add("hidden"));
  screen.classList.remove("hidden");
}

function showError(message) {
  console.error(message);
  const existing = document.querySelector(".aptly-error");
  if (existing) existing.remove();

  const banner = document.createElement("p");
  banner.className = "aptly-error";
  banner.textContent = message;
  screenHome.appendChild(banner);
}

function clearError() {
  const existing = document.querySelector(".aptly-error");
  if (existing) existing.remove();
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel(); // stop any question still being read
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1;
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.error("SpeechSynthesis failed:", err);
  }
}

/** Fade the question card out, swap its text, fade it back in. */
function transitionQuestion(newText) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduceMotion) {
    questionEl.textContent = newText;
    return;
  }

  questionEl.classList.add("is-transitioning");
  setTimeout(() => {
    questionEl.textContent = newText;
    questionEl.classList.remove("is-transitioning");
  }, 200);
}

function setListening(on) {
  questionEl.classList.toggle("is-listening", on);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (err) {
    throw new Error("The server sent back something unexpected.");
  }
}

function getScoreClass(score) {
  if (score >= 75) return "score-good";
  if (score >= 50) return "score-average";
  return "score-poor";
}

function scoreBadgeText(score) {
  if (score >= 75) return "Strong";
  if (score >= 50) return "Needs work";
  return "Weak";
}

/* ==========================================================================
   1. START INTERVIEW
   ========================================================================== */

async function startInterview() {
  if (isBusy) return;
  clearError();

  const jd = jdInput.value.trim();
  if (!jd) {
    showError("Please paste a job description before starting.");
    return;
  }

  isBusy = true;
  startBtn.disabled = true;
  startBtn.textContent = "Starting Interview...";

  try {
    const res = await fetch(`${API_BASE}/start_interview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jd }),
    });

    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);

    const data = await safeJson(res);
    if (!data.session_id || !data.question) {
      throw new Error("The server response was missing expected fields.");
    }

    sessionId = data.session_id;
    currentQuestion = data.question;
    questionNumber = 1;

    if (!videoWrap) buildDynamicInterviewUI();

    showScreen(screenInterview);
    questionEl.textContent = currentQuestion;
    updateCounter();
    setStatus("Ready");

    await setupCamera();
    speak(currentQuestion);
  } catch (err) {
    console.error(err);
    showError(
      "Unable to connect to Aptly's AI engine. Please make sure the backend is running at " +
        API_BASE +
        " and try again."
    );
  } finally {
    isBusy = false;
    startBtn.disabled = false;
    startBtn.textContent = "Start Interview";
  }
}

async function setupCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    webcamEl.srcObject = mediaStream;
  } catch (err) {
    console.error(err);
    let message = "Couldn't access your camera and microphone.";
    if (err.name === "NotAllowedError") {
      message = "Camera/microphone permission was denied. Please allow access and refresh to try again.";
    } else if (err.name === "NotFoundError") {
      message = "No camera or microphone was found on this device.";
    }
    questionEl.textContent = currentQuestion + "\n\n⚠ " + message;
  }
}

/* ==========================================================================
   2. RECORDING (toggleRecording)
   ========================================================================== */

function toggleRecording() {
  if (isBusy) return;
  if (!isRecording) {
    startRecording();
  } else {
    stopRecordingAndSubmit();
  }
}

function startRecording() {
  if (!mediaStream) {
    showQuestionWarning("Camera/microphone isn't available, so recording can't start.");
    return;
  }
  if (!window.MediaRecorder) {
    showQuestionWarning("Your browser doesn't support recording. Try Chrome or Edge.");
    return;
  }

  try {
    recordedChunks = [];
    const options = MediaRecorder.isTypeSupported("video/webm")
      ? { mimeType: "video/webm" }
      : undefined;
    mediaRecorder = new MediaRecorder(mediaStream, options);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.start();
    isRecording = true;

    recordBtn.textContent = "■ Stop & Submit Answer";
    recordBtn.classList.add("is-recording");
    showRecIndicator(true);
    setStatus("Recording", true);
    setListening(true);

    // Recording temporarily disables Finish Interview to avoid losing an in-progress answer
    if (finishBtn) finishBtn.disabled = true;
  } catch (err) {
    console.error(err);
    showQuestionWarning("Couldn't start recording. Please try again.");
  }
}

function stopRecordingAndSubmit() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;

  isRecording = false;
  showRecIndicator(false);
  if (finishBtn) finishBtn.disabled = false;

  mediaRecorder.onstop = () => submitAnswer();
  mediaRecorder.stop();
}

async function submitAnswer() {
  isBusy = true;
  recordBtn.disabled = true;
  recordBtn.classList.remove("is-recording");
  recordBtn.textContent = "Analyzing Answer...";
  setStatus("Analyzing Answer", true);
  showAnalyzing(true);

  const questionAtSubmitTime = currentQuestion;

  try {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const formData = new FormData();
    formData.append("file", blob, "answer.webm");
    formData.append("session_id", sessionId);
    formData.append("question", questionAtSubmitTime);

    const res = await fetch(`${API_BASE}/submit_answer`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);

    const data = await safeJson(res);
    if (!data.next_question) throw new Error("The server didn't return a next question.");

    // Only a successful submission advances the question count
    questionNumber++;
    updateCounter();

    currentQuestion = data.next_question;
    setStatus("Next Question", true);
    transitionQuestion(currentQuestion);
    speak(currentQuestion);
  } catch (err) {
    console.error(err);
    transitionQuestion(
      questionAtSubmitTime +
        "\n\n⚠ Couldn't analyze that answer — the connection to the server may have dropped. You can try recording again."
    );
    setStatus("Ready");
  } finally {
    isBusy = false;
    recordBtn.disabled = false;
    recordBtn.textContent = "● Start Answer";
    setListening(false);
    showAnalyzing(false);
    if (statusEl && statusEl._label.textContent === "Analyzing Answer") setStatus("Ready");
  }
}

function showQuestionWarning(message) {
  const original = currentQuestion;
  questionEl.textContent = original + "\n\n⚠ " + message;
  setTimeout(() => {
    questionEl.textContent = original;
  }, 3500);
}

/* ==========================================================================
   3. FINISH INTERVIEW
   ========================================================================== */

async function finishInterview() {
  // Stop any in-progress recording safely without submitting it
  if (isRecording && mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
    isRecording = false;
  }

  // Release camera/mic
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if ("speechSynthesis" in window) window.speechSynthesis.cancel();

  setStatus("Finishing Interview");
  showScreen(screenReport);
  renderReportLoading();

  try {
    const res = await fetch(`${API_BASE}/get_report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });

    if (!res.ok) throw new Error(`Server responded with status ${res.status}`);

    const data = await safeJson(res);
    clearReportLoading();
    renderReport(data);
  } catch (err) {
    console.error(err);
    clearReportLoading();
    reportOutput.innerHTML = "";
    const raw = document.createElement("div");
    raw.className = "aptly-raw";
    raw.textContent =
      "Unable to connect to Aptly's AI engine while generating your report.\n\nPlease check that the backend is running and try finishing the interview again.";
    reportOutput.appendChild(raw);
  }
}

/* ---------- Report loading state ---------- */

let reportLoadingEl = null;
let reportLoadingInterval = null;

function renderReportLoading() {
  reportOutput.innerHTML = "";

  const messages = [
    "Analyzing your interview...",
    "Evaluating communication...",
    "Preparing your report...",
  ];
  let i = 0;

  reportLoadingEl = document.createElement("div");
  reportLoadingEl.className = "aptly-report-loading";
  reportLoadingEl.innerHTML = `
    <div class="aptly-spinner"></div>
    <div class="aptly-loading-text">${messages[0]}</div>
  `;
  reportOutput.appendChild(reportLoadingEl);

  const textEl = reportLoadingEl.querySelector(".aptly-loading-text");
  reportLoadingInterval = setInterval(() => {
    i = (i + 1) % messages.length;
    textEl.textContent = messages[i];
  }, 1600);
}

function clearReportLoading() {
  if (reportLoadingInterval) clearInterval(reportLoadingInterval);
  if (reportLoadingEl) {
    reportLoadingEl.remove();
    reportLoadingEl = null;
  }
}

/* ---------- Score count-up animation ---------- */

function animateScoreNumber(el, target) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    el.textContent = Math.round(target);
    return;
  }

  const duration = 700;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    el.textContent = Math.round(target * eased);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- Report dashboard rendering ---------- */

function renderReport(report) {
  reportOutput.innerHTML = "";
  setStatus("Ready");

  if (!report || typeof report !== "object") {
    const raw = document.createElement("div");
    raw.className = "aptly-raw";
    raw.textContent = String(report);
    reportOutput.appendChild(raw);
    return;
  }

  try {
    if ("overall_score" in report) renderHeroScore(report);
    renderMetricGrid(report);
    if (Array.isArray(report.top_problems) && report.top_problems.length) {
      renderTopProblems(report.top_problems);
    }
    if (Array.isArray(report.full_history) && report.full_history.length) {
      renderQuestionBreakdown(report.full_history);
    }

    // If nothing rendered (unexpected shape), fall back to raw JSON so no data is lost
    if (reportOutput.children.length === 0) {
      const raw = document.createElement("div");
      raw.className = "aptly-raw";
      raw.textContent = JSON.stringify(report, null, 2);
      reportOutput.appendChild(raw);
    }
  } catch (err) {
    console.error("Failed to render structured report, falling back to raw JSON:", err);
    reportOutput.innerHTML = "";
    const raw = document.createElement("div");
    raw.className = "aptly-raw";
    raw.textContent = JSON.stringify(report, null, 2);
    reportOutput.appendChild(raw);
  }
}

function renderHeroScore(report) {
  const overall = Number(report.overall_score) || 0;
  const cls = getScoreClass(overall);

  const hero = document.createElement("div");
  hero.className = "aptly-hero-score";
  hero.innerHTML = `
    <div class="aptly-hero-ring ${cls}" style="--pct:${overall}">
      <span class="aptly-hero-ring-value">0</span>
    </div>
    <div class="aptly-hero-text">
      <div class="aptly-hero-title">Overall Score</div>
      <div class="aptly-hero-sub">${scoreBadgeText(overall)} performance across this interview</div>
    </div>
  `;
  reportOutput.appendChild(hero);
  animateScoreNumber(hero.querySelector(".aptly-hero-ring-value"), overall);
}

function renderMetricGrid(report) {
  const metrics = [];

  if ("content_score" in report) metrics.push({ label: "Content Score", value: Number(report.content_score) || 0 });
  if ("avg_wpm" in report) metrics.push({ label: "Avg WPM", value: Number(report.avg_wpm) || 0, noBadge: true });
  if ("avg_eye_contact_pct" in report) metrics.push({ label: "Eye Contact", value: Number(report.avg_eye_contact_pct) || 0, suffix: "%" });
  if ("total_filler_words" in report) metrics.push({ label: "Filler Words", value: Number(report.total_filler_words) || 0, noBadge: true, inverse: true });

  if (!metrics.length) return;

  const label = document.createElement("div");
  label.className = "aptly-section-label";
  label.textContent = "Performance Metrics";
  reportOutput.appendChild(label);

  const grid = document.createElement("div");
  grid.className = "aptly-score-grid";

  metrics.forEach(({ label, value, suffix, noBadge, inverse }, i) => {
    const displayValue = suffix === "%" || !noBadge ? Math.round(value) : Math.round(value);
    // Only apply green/orange/red semantics to 0-100 "score-like" metrics
    const cls = noBadge ? "" : getScoreClass(value);

    const card = document.createElement("div");
    card.className = `aptly-score-card ${cls}`;
    card.style.animationDelay = `${i * 70}ms`;
    card.innerHTML = `
      <div class="aptly-score-value">${displayValue}${suffix || ""}</div>
      <div class="aptly-score-label">${label}</div>
      ${!noBadge ? `<div class="aptly-score-badge">${scoreBadgeText(value)}</div>` : ""}
    `;
    grid.appendChild(card);
    animateScoreNumber(card.querySelector(".aptly-score-value"), value);
    // re-append suffix after count-up since animateScoreNumber overwrites textContent
    if (suffix) {
      setTimeout(() => {
        const valEl = card.querySelector(".aptly-score-value");
        if (!valEl.textContent.includes(suffix)) valEl.textContent += suffix;
      }, 750);
    }
  });

  reportOutput.appendChild(grid);
}

function renderTopProblems(problems) {
  const label = document.createElement("div");
  label.className = "aptly-section-label";
  label.textContent = "Top Problems & Practice Drills";
  reportOutput.appendChild(label);

  const list = document.createElement("div");
  list.className = "aptly-problem-list";

  problems.forEach((p, i) => {
    const problemText = typeof p === "string" ? p : p.problem || "Issue identified";
    const drillText = typeof p === "object" ? p.drill : null;

    const card = document.createElement("div");
    card.className = "aptly-problem-card";
    card.style.animationDelay = `${i * 90}ms`;
    card.innerHTML = `
      <div class="aptly-problem-title">${escapeHtml(problemText)}</div>
      ${drillText ? `<div class="aptly-drill">${escapeHtml(drillText)}</div>` : ""}
    `;
    list.appendChild(card);
  });

  reportOutput.appendChild(list);
}

function renderQuestionBreakdown(history) {
  const label = document.createElement("div");
  label.className = "aptly-section-label";
  label.textContent = "Question-by-Question Breakdown";
  reportOutput.appendChild(label);

  const list = document.createElement("div");
  list.className = "aptly-qa-list";

  history.forEach((entry, i) => {
    const card = document.createElement("div");
    card.className = "aptly-qa-card";
    card.style.animationDelay = `${i * 100}ms`;

    let html = `<div class="aptly-qa-question">Q${i + 1}. ${escapeHtml(entry.question || "")}</div>`;

    if (entry.answer) {
      html += `<div class="aptly-qa-answer">${escapeHtml(truncate(entry.answer, 220))}</div>`;
    }

    // Metric chips from speech/vision/content
    const chips = [];
    if (entry.speech) {
      if ("wpm" in entry.speech) chips.push(`${entry.speech.wpm} WPM`);
      if (Array.isArray(entry.speech.filler_words)) chips.push(`${entry.speech.filler_words.length} filler words`);
      if (Array.isArray(entry.speech.pauses)) chips.push(`${entry.speech.pauses.length} long pauses`);
    }
    if (entry.vision && "eye_contact_pct" in entry.vision) {
      chips.push(`${Math.round(entry.vision.eye_contact_pct)}% eye contact`);
    }
    if (chips.length) {
      html += `<div class="aptly-qa-metrics">${chips.map((c) => `<span class="aptly-chip">${escapeHtml(c)}</span>`).join("")}</div>`;
    }

    card.innerHTML = html;

    // STAR badges
    if (entry.content && entry.content.star) {
      const star = entry.content.star;
      const row = document.createElement("div");
      row.className = "aptly-star-row";
      ["situation", "task", "action", "result"].forEach((key, idx) => {
        if (!(key in star)) return;
        const complete = !!star[key];
        const badge = document.createElement("span");
        badge.className = `aptly-star-badge ${complete ? "is-complete" : "is-missing"}`;
        badge.style.animationDelay = `${idx * 60}ms`;
        badge.textContent = `${complete ? "✓" : "✕"} ${key.charAt(0).toUpperCase() + key.slice(1)}`;
        row.appendChild(badge);
      });
      card.appendChild(row);
    }

    // One-line feedback
    if (entry.content && entry.content.one_line_feedback) {
      const feedback = document.createElement("div");
      feedback.className = "aptly-feedback-line";
      feedback.textContent = entry.content.one_line_feedback;
      card.appendChild(feedback);
    }

    list.appendChild(card);
  });

  reportOutput.appendChild(list);
}

/* ---------- Text helpers ---------- */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max).trim() + "…" : str;
}
