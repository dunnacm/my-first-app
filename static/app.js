const state = {
    home: null,
    settings: null,
    problems: [],
    results: [],
    currentIndex: 0,
    correctCount: 0,
    missedCount: 0,
    streak: 0,
    bestStreak: 0,
    paused: false,
    transitioning: false,
    finishing: false,
    intervalId: null,
    problemStartedAt: null,
    sessionStartedAt: null,
    frozenProblemMs: 0,
    frozenSessionMs: 0,
    completedSessionMs: 0,
};

let timeChart = null;
let progressChart = null;

const $ = (id) => document.getElementById(id);

function showScreen(screenId) {
    ["home-screen", "exercise-screen", "stats-screen"].forEach((id) => {
        $(id).classList.toggle("hidden", id !== screenId);
    });
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function mean(values) {
    if (!values.length) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatClock(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatShortSeconds(seconds) {
    if (seconds == null || Number.isNaN(seconds)) {
        return "--";
    }
    if (seconds < 60) {
        return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function currentProblemMs() {
    if (!state.problemStartedAt) {
        return state.frozenProblemMs;
    }
    if (state.paused) {
        return state.frozenProblemMs;
    }
    return state.frozenProblemMs + (performance.now() - state.problemStartedAt);
}

function currentSessionMs() {
    if (!state.sessionStartedAt) {
        return state.frozenSessionMs;
    }
    if (state.paused) {
        return state.frozenSessionMs;
    }
    return state.frozenSessionMs + (performance.now() - state.sessionStartedAt);
}

function stopTicker() {
    if (state.intervalId) {
        clearInterval(state.intervalId);
        state.intervalId = null;
    }
}

function startTicker() {
    stopTicker();
    state.intervalId = setInterval(() => {
        updateExerciseMetrics();
        enforceTimePressure();
    }, 100);
}

function currentProblem() {
    return state.problems[state.currentIndex];
}

function updateExerciseMetrics() {
    $("session-timer").textContent = formatClock(currentSessionMs());
    $("problem-timer").textContent = formatClock(currentProblemMs());
    $("progress-counter").textContent = `${state.results.length} / ${state.problems.length}`;
    $("streak-counter").textContent = `Streak ${state.streak}`;
    $("task-limit-text").textContent = state.settings?.time_limit
        ? `Limit ${state.settings.time_limit}s`
        : "No limit";
}

function updateExerciseView() {
    const problem = currentProblem();
    if (!problem) {
        return;
    }

    $("problem-text").textContent = problem.label;
    $("answer-input").value = "";
    $("pause-btn").textContent = state.paused ? "Resume" : "Pause";
    updateExerciseMetrics();

    if (!state.paused) {
        window.setTimeout(() => $("answer-input").focus(), 20);
    }
}

function setPaused(nextPaused) {
    if (state.paused === nextPaused) {
        return;
    }

    if (nextPaused) {
        state.frozenProblemMs = currentProblemMs();
        state.frozenSessionMs = currentSessionMs();
        state.paused = true;
        $("pause-overlay").classList.remove("hidden");
        $("answer-input").disabled = true;
    } else {
        state.paused = false;
        state.problemStartedAt = performance.now();
        state.sessionStartedAt = performance.now();
        $("pause-overlay").classList.add("hidden");
        $("answer-input").disabled = false;
        window.setTimeout(() => $("answer-input").focus(), 20);
    }

    updateExerciseView();
}

function flashFeedback(kind, text) {
    const banner = $("feedback-banner");
    const panel = document.querySelector(".exercise-panel");
    banner.textContent = text;
    banner.className = `feedback-banner ${kind === "ok" ? "ok" : "bad"}`;
    panel.classList.remove("flash-correct", "flash-wrong");
    panel.classList.add(kind === "ok" ? "flash-correct" : "flash-wrong");

    window.setTimeout(() => {
        banner.textContent = "";
        banner.className = "feedback-banner";
        panel.classList.remove("flash-correct", "flash-wrong");
    }, 260);
}

function resetProblemTimer() {
    state.frozenProblemMs = 0;
    state.problemStartedAt = performance.now();
}

function completeCurrentProblem({ correct, skipped, message }) {
    if (state.transitioning || state.finishing) {
        return;
    }

    const problem = currentProblem();
    if (!problem) {
        return;
    }

    state.transitioning = true;
    const responseTime = Number((currentProblemMs() / 1000).toFixed(3));

    state.results.push({
        problem_key: problem.key,
        a: problem.a,
        b: problem.b,
        label: problem.label,
        correct,
        skipped,
        response_time: responseTime,
    });

    if (correct) {
        state.correctCount += 1;
        state.streak += 1;
        state.bestStreak = Math.max(state.bestStreak, state.streak);
        flashFeedback("ok", message || "Correct");
    } else {
        state.missedCount += 1;
        state.streak = 0;
        flashFeedback("bad", message || (skipped ? "Skipped" : "Missed"));
    }

    window.setTimeout(() => {
        state.currentIndex += 1;
        state.transitioning = false;

        if (state.currentIndex >= state.problems.length) {
            finishSession({ endedEarly: false });
            return;
        }

        resetProblemTimer();
        updateExerciseView();
    }, 280);
}

function enforceTimePressure() {
    if (!state.settings?.time_limit || state.paused || state.transitioning || state.finishing) {
        return;
    }
    if ((currentProblemMs() / 1000) >= state.settings.time_limit) {
        completeCurrentProblem({ correct: false, skipped: true, message: "Time up" });
    }
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload.error || "Request failed.");
    }
    return payload;
}

function serverSettingsFromPayload(payload) {
    return {
        mode: payload.mode,
        min_a: payload.min_a,
        max_a: payload.max_a,
        session_size: payload.session_size,
        time_limit: payload.time_limit,
    };
}

async function startSession(settings) {
    try {
        const payload = await fetchJson("/api/session/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
        });

        state.settings = serverSettingsFromPayload(payload);
        state.home = payload.home;
        state.problems = payload.problems;
        state.results = [];
        state.currentIndex = 0;
        state.correctCount = 0;
        state.missedCount = 0;
        state.streak = 0;
        state.bestStreak = 0;
        state.paused = false;
        state.transitioning = false;
        state.finishing = false;
        state.frozenProblemMs = 0;
        state.frozenSessionMs = 0;
        state.completedSessionMs = 0;
        state.problemStartedAt = performance.now();
        state.sessionStartedAt = performance.now();

        $("answer-input").disabled = false;
        $("pause-overlay").classList.add("hidden");
        showScreen("exercise-screen");
        updateExerciseView();
        startTicker();
    } catch (error) {
        window.alert(error.message);
    }
}

function gatherSettingsFromForm() {
    const mode = $("mode-select").value;
    const minA = clamp(parseInt($("min-a-input").value || "1", 10), 1, 20);
    const maxA = clamp(parseInt($("max-a-input").value || "20", 10), minA, 20);
    const timePressure = $("time-pressure-checkbox").checked;
    const timeLimit = timePressure
        ? clamp(parseInt($("time-limit-input").value || "20", 10), 3, 120)
        : null;

    let sessionSize = parseInt($("session-size-input").value || "40", 10);
    sessionSize = clamp(sessionSize, 5, 190);

    return {
        mode,
        min_a: minA,
        max_a: maxA,
        session_size: sessionSize,
        time_limit: timeLimit,
    };
}

function updateModeDependentFields() {
    const fullDeck = $("mode-select").value === "full";
    $("session-size-field").style.display = fullDeck ? "none" : "flex";
    $("time-limit-field").style.display = $("time-pressure-checkbox").checked ? "flex" : "none";
}

function buildSessionPayload(endedEarly) {
    const total = state.results.length;
    const avgTime = mean(state.results.map((result) => result.response_time));
    const accuracy = total ? ((state.correctCount / total) * 100) : 0;

    return {
        ...state.settings,
        session_size: state.problems.length,
        session_duration: Number((state.completedSessionMs / 1000).toFixed(3)),
        results: state.results,
        accuracy: Number(accuracy.toFixed(2)),
        avg_time: Number(avgTime.toFixed(3)),
        best_streak: state.bestStreak,
        ended_early: endedEarly,
    };
}

async function finishSession({ endedEarly }) {
    if (state.finishing) {
        return;
    }

    stopTicker();
    state.finishing = true;
    state.completedSessionMs = currentSessionMs();
    state.frozenSessionMs = state.completedSessionMs;
    state.frozenProblemMs = currentProblemMs();
    state.paused = true;

    if (!state.results.length) {
        state.finishing = false;
        showScreen("home-screen");
        await refreshHome();
        return;
    }

    try {
        const data = await fetchJson("/api/session/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildSessionPayload(endedEarly)),
        });

        state.home = data.home;
        renderStats(data);
        showScreen("stats-screen");
    } catch (error) {
        window.alert(error.message);
        showScreen("home-screen");
        await refreshHome();
    } finally {
        state.finishing = false;
    }
}

function renderHome(data) {
    state.home = data;
    $("home-best-time").textContent = data.personal_best_avg_time == null
        ? "--"
        : `${Number(data.personal_best_avg_time).toFixed(2)}s`;
    $("home-total-sessions").textContent = data.total_sessions;
    $("home-focus-text").textContent = data.historical_focus_text;
}

function destroyCharts() {
    if (timeChart) {
        timeChart.destroy();
        timeChart = null;
    }
    if (progressChart) {
        progressChart.destroy();
        progressChart = null;
    }
}

function baseChartOptions() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
        },
        scales: {
            x: {
                ticks: { color: "#91a4bc", maxRotation: 0, autoSkip: true },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
            },
            y: {
                ticks: { color: "#91a4bc" },
                grid: { color: "rgba(255, 255, 255, 0.05)" },
            },
        },
    };
}

function renderTimeChart() {
    const context = $("time-chart").getContext("2d");
    timeChart = new Chart(context, {
        type: "line",
        data: {
            labels: state.results.map((result) => result.label),
            datasets: [{
                data: state.results.map((result) => result.response_time),
                borderColor: "#efc96f",
                backgroundColor: "rgba(239, 201, 111, 0.14)",
                borderWidth: 3,
                pointRadius: 3,
                tension: 0.28,
                fill: true,
            }],
        },
        options: {
            ...baseChartOptions(),
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => `${context.parsed.y.toFixed(2)}s`,
                    },
                },
            },
        },
    });
}

function renderProgressChart(history) {
    const context = $("progress-chart").getContext("2d");
    progressChart = new Chart(context, {
        type: "line",
        data: {
            labels: history.map((item, index) => item.label || `S${index + 1}`),
            datasets: [{
                data: history.map((item) => item.avg_time),
                borderColor: "#7bc1ff",
                backgroundColor: "rgba(123, 193, 255, 0.12)",
                borderWidth: 3,
                pointRadius: 3,
                tension: 0.28,
                fill: true,
            }],
        },
        options: {
            ...baseChartOptions(),
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => `${context.parsed.y.toFixed(2)}s avg`,
                    },
                },
            },
        },
    });
}

function heatColor(cell) {
    if (!cell || !cell.attempts) {
        return "rgba(255, 255, 255, 0.05)";
    }

    const accuracyPenalty = 1 - ((cell.accuracy || 0) / 100);
    const timePenalty = clamp((cell.avg_time || 0) / 10, 0, 1);
    const difficultyPenalty = clamp(((cell.difficulty || 1) - 0.2) / 4.5, 0, 1);
    const score = clamp(
        (accuracyPenalty * 0.55) + (timePenalty * 0.25) + (difficultyPenalty * 0.20),
        0,
        1
    );
    const hue = 120 - (120 * score);
    return `hsl(${hue}, 70%, 36%)`;
}

function renderHeatmap(heatmap) {
    const container = $("heatmap-grid");
    container.innerHTML = "";

    for (let a = 2; a <= 20; a += 1) {
        const row = document.createElement("div");
        row.className = "heatmap-row";

        const label = document.createElement("div");
        label.className = "heatmap-row-label";
        label.textContent = a;
        row.appendChild(label);

        const cells = heatmap
            .filter((cell) => cell.a === a)
            .sort((left, right) => left.b - right.b);

        cells.forEach((cell) => {
            const square = document.createElement("div");
            square.className = "heatmap-cell";
            square.style.background = heatColor(cell);
            square.textContent = cell.b;

            const accuracyText = cell.accuracy == null ? "--" : `${cell.accuracy.toFixed(1)}%`;
            const avgText = cell.avg_time == null ? "--" : `${cell.avg_time.toFixed(2)}s`;
            square.title = `${cell.label}\nAttempts: ${cell.attempts}\nAccuracy: ${accuracyText}\nAvg: ${avgText}`;
            row.appendChild(square);
        });

        container.appendChild(row);
    }
}

function renderStats(serverData) {
    destroyCharts();

    const total = state.results.length;
    const avgTime = mean(state.results.map((result) => result.response_time));
    const accuracy = total ? ((state.correctCount / total) * 100) : 0;

    $("correct-count").textContent = String(state.correctCount);
    $("missed-count").textContent = String(state.missedCount);
    $("avg-time").textContent = formatShortSeconds(avgTime);
    $("task-time").textContent = state.settings.time_limit ? `${state.settings.time_limit}s` : "--";
    $("accuracy-value").textContent = `${accuracy.toFixed(1)}%`;
    $("session-duration").textContent = formatShortSeconds(state.completedSessionMs / 1000);
    $("best-streak").textContent = String(state.bestStreak);
    $("personal-best-value").textContent = serverData.personal_best_avg_time == null
        ? "--"
        : `${Number(serverData.personal_best_avg_time).toFixed(2)}s`;
    $("summary-sentence").textContent = serverData.summary;
    $("best-badge").classList.toggle("hidden", !serverData.is_new_best);

    renderTimeChart();
    renderProgressChart(serverData.home.recent_sessions || []);
    renderHeatmap(serverData.home.heatmap || []);
}

async function refreshHome() {
    try {
        const data = await fetchJson("/api/home");
        renderHome(data);
    } catch (error) {
        window.alert(error.message);
    }
}

function parseAnswer(rawValue) {
    const trimmed = rawValue.trim();
    if (trimmed === "") {
        return null;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
        return null;
    }
    return numeric;
}

async function handleEarlyFinish() {
    const confirmed = window.confirm("End the session now and score only the completed problems?");
    if (!confirmed) {
        return;
    }
    await finishSession({ endedEarly: true });
}

function bindEvents() {
    $("start-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        updateModeDependentFields();
        await startSession(gatherSettingsFromForm());
    });

    $("mode-select").addEventListener("change", updateModeDependentFields);
    $("time-pressure-checkbox").addEventListener("change", updateModeDependentFields);

    $("answer-form").addEventListener("submit", (event) => {
        event.preventDefault();
        if (state.paused || state.transitioning || state.finishing) {
            return;
        }

        const value = parseAnswer($("answer-input").value);
        if (value == null) {
            flashFeedback("bad", "Enter a number");
            return;
        }

        const problem = currentProblem();
        if (!problem) {
            return;
        }

        const correctAnswer = problem.a - problem.b;
        completeCurrentProblem({
            correct: value === correctAnswer,
            skipped: false,
            message: value === correctAnswer ? "Correct" : `Missed - ${problem.label} = ${correctAnswer}`,
        });
    });

    $("skip-btn").addEventListener("click", () => {
        if (state.paused || state.transitioning || state.finishing) {
            return;
        }
        completeCurrentProblem({ correct: false, skipped: true, message: "Skipped" });
    });

    $("pause-btn").addEventListener("click", () => {
        setPaused(!state.paused);
    });

    $("restart-btn").addEventListener("click", async () => {
        if (!state.settings) {
            return;
        }
        const confirmed = window.confirm("Restart this session from the beginning?");
        if (!confirmed) {
            return;
        }
        stopTicker();
        await startSession({ ...state.settings });
    });

    $("play-again-btn").addEventListener("click", async () => {
        if (!state.settings) {
            return;
        }
        await startSession({ ...state.settings });
    });

    $("home-btn").addEventListener("click", async () => {
        stopTicker();
        showScreen("home-screen");
        await refreshHome();
    });

    document.addEventListener("keydown", async (event) => {
        if ($("exercise-screen").classList.contains("hidden")) {
            return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        if (state.transitioning || state.finishing) {
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            await handleEarlyFinish();
            return;
        }

        if (event.key.toLowerCase() === "p") {
            event.preventDefault();
            setPaused(!state.paused);
            return;
        }

        if (event.key.toLowerCase() === "s" && !state.paused) {
            event.preventDefault();
            completeCurrentProblem({ correct: false, skipped: true, message: "Skipped" });
        }
    });
}

window.addEventListener("load", async () => {
    bindEvents();
    updateModeDependentFields();
    await refreshHome();
});
