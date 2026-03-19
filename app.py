import os
import random
import statistics
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()


class PracticeSession(db.Model):
    __tablename__ = "practice_sessions"

    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    mode = db.Column(db.String(32), nullable=False)
    min_a = db.Column(db.Integer, nullable=False)
    max_a = db.Column(db.Integer, nullable=False)
    requested_size = db.Column(db.Integer, nullable=False)
    total_problems = db.Column(db.Integer, nullable=False)
    correct_count = db.Column(db.Integer, nullable=False)
    missed_count = db.Column(db.Integer, nullable=False)
    best_streak = db.Column(db.Integer, nullable=False, default=0)
    accuracy = db.Column(db.Float, nullable=False)
    avg_time = db.Column(db.Float, nullable=False)
    task_time_limit = db.Column(db.Integer, nullable=True)
    session_duration = db.Column(db.Float, nullable=False)
    ended_early = db.Column(db.Boolean, nullable=False, default=False)
    summary = db.Column(db.Text, nullable=True)


class SessionProblemResult(db.Model):
    __tablename__ = "session_problem_results"

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(
        db.Integer,
        db.ForeignKey("practice_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    problem_key = db.Column(db.String(16), nullable=False, index=True)
    a = db.Column(db.Integer, nullable=False)
    b = db.Column(db.Integer, nullable=False)
    correct = db.Column(db.Boolean, nullable=False)
    skipped = db.Column(db.Boolean, nullable=False, default=False)
    response_time = db.Column(db.Float, nullable=False)


class ProblemStat(db.Model):
    __tablename__ = "problem_stats"

    problem_key = db.Column(db.String(16), primary_key=True)
    a = db.Column(db.Integer, nullable=False, index=True)
    b = db.Column(db.Integer, nullable=False, index=True)
    attempts = db.Column(db.Integer, nullable=False, default=0)
    correct_count = db.Column(db.Integer, nullable=False, default=0)
    missed_count = db.Column(db.Integer, nullable=False, default=0)
    total_time = db.Column(db.Float, nullable=False, default=0.0)
    avg_time = db.Column(db.Float, nullable=False, default=0.0)
    consecutive_fast_correct = db.Column(db.Integer, nullable=False, default=0)
    difficulty_score = db.Column(db.Float, nullable=False, default=1.0)
    last_seen = db.Column(db.DateTime, nullable=True)


def normalize_database_url(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    if value.startswith("postgres://"):
        return value.replace("postgres://", "postgresql+psycopg://", 1)
    if value.startswith("postgresql://"):
        return value.replace("postgresql://", "postgresql+psycopg://", 1)
    return value


def create_app() -> Flask:
    app = Flask(__name__)
    os.makedirs(app.instance_path, exist_ok=True)

    default_sqlite = f"sqlite:///{os.path.join(app.instance_path, 'subtraction_hud.db')}"
    app.config["SQLALCHEMY_DATABASE_URI"] = (
        normalize_database_url(os.getenv("DATABASE_URL")) or default_sqlite
    )
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["JSON_SORT_KEYS"] = False

    db.init_app(app)

    with app.app_context():
        db.create_all()

    register_routes(app)
    return app


def problem_key(a: int, b: int) -> str:
    return f"{a}-{b}"


def build_problem_pool(min_a: int, max_a: int) -> List[Tuple[int, int]]:
    min_a = max(1, min(int(min_a), 20))
    max_a = max(min_a, min(int(max_a), 20))
    pool: List[Tuple[int, int]] = []

    # The prompt also asks for a 190-problem deck, which only matches
    # positive integer pairs where 1 <= B < A <= 20.
    for a in range(min_a, max_a + 1):
        for b in range(1, a):
            pool.append((a, b))
    return pool


def difficulty_for_problem(a: int, b: int) -> float:
    stat = db.session.get(ProblemStat, problem_key(a, b))
    return stat.difficulty_score if stat else 1.25


def calculate_difficulty(stat: ProblemStat) -> float:
    if stat.attempts <= 0:
        return 1.25

    error_rate = stat.missed_count / stat.attempts
    time_factor = min(stat.avg_time / 8.0, 2.5)
    mastery_discount = min(stat.consecutive_fast_correct * 0.2, 1.2)
    score = 0.7 + (error_rate * 3.3) + time_factor - mastery_discount
    return round(max(0.2, score), 3)


def weighted_sample_without_replacement(
    items: List[Tuple[int, int]], weights: List[float], sample_size: int
) -> List[Tuple[int, int]]:
    if sample_size >= len(items):
        output = list(items)
        random.shuffle(output)
        return output

    pool = list(zip(items, weights))
    selected: List[Tuple[int, int]] = []

    while pool and len(selected) < sample_size:
        current_items = [item for item, _ in pool]
        current_weights = [max(weight, 0.001) for _, weight in pool]
        picked = random.choices(current_items, weights=current_weights, k=1)[0]
        selected.append(picked)
        pool = [(item, weight) for item, weight in pool if item != picked]

    return selected


def adaptive_problem_set(pool: List[Tuple[int, int]], requested_size: int) -> List[Tuple[int, int]]:
    sample_size = max(1, min(requested_size, len(pool)))
    weights = [difficulty_for_problem(a, b) + 0.15 for a, b in pool]
    selected = weighted_sample_without_replacement(pool, weights, sample_size)
    random.shuffle(selected)
    return selected


def weak_problem_set(pool: List[Tuple[int, int]], requested_size: int) -> List[Tuple[int, int]]:
    sample_size = max(1, min(requested_size, len(pool)))
    seen_stats: List[ProblemStat] = []

    for a, b in pool:
        stat = db.session.get(ProblemStat, problem_key(a, b))
        if stat and stat.attempts > 0:
            seen_stats.append(stat)

    if not seen_stats:
        fallback = list(pool)
        random.shuffle(fallback)
        return fallback[:sample_size]

    seen_stats.sort(
        key=lambda stat: (
            stat.difficulty_score,
            stat.missed_count,
            stat.avg_time,
            -stat.correct_count,
        ),
        reverse=True,
    )

    selected = [(stat.a, stat.b) for stat in seen_stats[:sample_size]]
    selected_keys = {problem_key(a, b) for a, b in selected}

    if len(selected) < sample_size:
        remainder = [(a, b) for a, b in pool if problem_key(a, b) not in selected_keys]
        random.shuffle(remainder)
        selected.extend(remainder[: sample_size - len(selected)])

    random.shuffle(selected)
    return selected


def average(values: List[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.fmean(values))


def get_personal_best_avg_time() -> Optional[float]:
    sessions = PracticeSession.query.filter(PracticeSession.total_problems > 0).all()
    if not sessions:
        return None
    return round(min(session.avg_time for session in sessions), 3)


def serialize_session(session: PracticeSession) -> Dict:
    return {
        "id": session.id,
        "label": session.created_at.strftime("%b %d"),
        "created_at": session.created_at.isoformat(),
        "mode": session.mode,
        "avg_time": round(session.avg_time, 3),
        "accuracy": round(session.accuracy, 2),
        "total_problems": session.total_problems,
    }


def build_heatmap_payload() -> List[Dict]:
    stats_map = {stat.problem_key: stat for stat in ProblemStat.query.all()}
    payload: List[Dict] = []

    for a in range(1, 21):
        for b in range(1, a):
            key = problem_key(a, b)
            stat = stats_map.get(key)
            attempts = stat.attempts if stat else 0
            correct = stat.correct_count if stat else 0
            accuracy = (correct / attempts * 100.0) if attempts else None
            payload.append(
                {
                    "key": key,
                    "a": a,
                    "b": b,
                    "label": f"{a} - {b}",
                    "attempts": attempts,
                    "accuracy": round(accuracy, 2) if accuracy is not None else None,
                    "avg_time": round(stat.avg_time, 3) if stat else None,
                    "difficulty": round(stat.difficulty_score, 3) if stat else None,
                }
            )

    return payload


def historical_focus_text() -> str:
    stats = ProblemStat.query.filter(ProblemStat.attempts > 0).all()
    if not stats:
        return "Your historical focus area will appear after the first saved session."

    by_a: Dict[int, List[ProblemStat]] = defaultdict(list)
    for stat in stats:
        by_a[stat.a].append(stat)

    weakest_window: Optional[Tuple[int, int]] = None
    weakest_score = float("-inf")

    for start in range(2, 18):
        end = start + 3
        bucket: List[ProblemStat] = []
        for a in range(start, end + 1):
            bucket.extend(by_a.get(a, []))
        if not bucket:
            continue
        score = average([stat.difficulty_score for stat in bucket])
        if score > weakest_score:
            weakest_score = score
            weakest_window = (start, end)

    if not weakest_window:
        return "Your historical focus area will appear after the first saved session."

    return (
        f"Historically, subtracting from {weakest_window[0]}-{weakest_window[1]} "
        f"has been your weakest range."
    )


def home_payload() -> Dict:
    sessions = PracticeSession.query.order_by(PracticeSession.created_at.asc()).all()
    recent_sessions = [serialize_session(session) for session in sessions[-20:]]

    return {
        "personal_best_avg_time": get_personal_best_avg_time(),
        "total_sessions": len(sessions),
        "recent_sessions": recent_sessions,
        "historical_focus_text": historical_focus_text(),
        "heatmap": build_heatmap_payload(),
    }


def build_problem_payload(problems: List[Tuple[int, int]]) -> List[Dict]:
    return [
        {
            "key": problem_key(a, b),
            "a": a,
            "b": b,
            "label": f"{a} - {b}",
        }
        for a, b in problems
    ]


def generate_session_summary(results: List[Dict], accuracy: float, avg_time: float) -> str:
    if not results:
        return "No problems were completed."

    if accuracy == 100.0 and avg_time <= 4.0:
        return "Fast and clean session. You stayed accurate while keeping the pace high."

    weakest_window: Optional[Tuple[int, int]] = None
    weakest_score = float("-inf")

    for start in range(2, 18):
        end = start + 3
        bucket = [result for result in results if start <= int(result["a"]) <= end]
        if not bucket:
            continue
        score = average(
            [
                float(result["response_time"]) + (6.0 if not bool(result["correct"]) else 0.0)
                for result in bucket
            ]
        )
        if score > weakest_score:
            weakest_score = score
            weakest_window = (start, end)

    if weakest_window:
        return (
            f"Your weakest area this session was subtracting from "
            f"{weakest_window[0]}-{weakest_window[1]}. Target that band next time."
        )

    return "Solid session. Repeat the deck and aim to lower your average response time."


def safe_int(value: Optional[object], default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def safe_float(value: Optional[object], default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def safe_bool(value: Optional[object], default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return default


def register_routes(app: Flask) -> None:
    @app.get("/")
    def index() -> str:
        return render_template("index.html")

    @app.get("/api/home")
    def api_home():
        return jsonify(home_payload())

    @app.post("/api/session/start")
    def api_session_start():
        data = request.get_json(silent=True) or {}

        mode = str(data.get("mode", "full")).strip().lower()
        min_a = safe_int(data.get("min_a"), 1)
        max_a = safe_int(data.get("max_a"), 20)
        requested_size = safe_int(data.get("session_size"), 40)
        time_limit = safe_int(data.get("time_limit"), 0)

        pool = build_problem_pool(min_a=min_a, max_a=max_a)
        if not pool:
            return jsonify({"error": "No problems exist for that configuration."}), 400

        if mode == "adaptive":
            selected = adaptive_problem_set(pool, requested_size)
        elif mode == "weak":
            selected = weak_problem_set(pool, requested_size)
        else:
            selected = list(pool)
            random.shuffle(selected)
            mode = "full"

        return jsonify(
            {
                "mode": mode,
                "min_a": min_a,
                "max_a": max_a,
                "session_size": len(selected),
                "time_limit": time_limit if time_limit > 0 else None,
                "problems": build_problem_payload(selected),
                "home": home_payload(),
            }
        )

    @app.post("/api/session/complete")
    def api_session_complete():
        data = request.get_json(silent=True) or {}
        raw_results = data.get("results", []) or []

        sanitized_results: List[Dict] = []
        for result in raw_results:
            a = safe_int(result.get("a"), 0)
            b = safe_int(result.get("b"), 0)
            if a <= 0 or b <= 0 or b >= a:
                continue

            sanitized_results.append(
                {
                    "problem_key": problem_key(a, b),
                    "a": a,
                    "b": b,
                    "correct": safe_bool(result.get("correct")),
                    "skipped": safe_bool(result.get("skipped")),
                    "response_time": max(0.0, safe_float(result.get("response_time"), 0.0)),
                }
            )

        total_problems = len(sanitized_results)
        correct_count = sum(1 for result in sanitized_results if result["correct"])
        missed_count = total_problems - correct_count
        best_streak = max(0, safe_int(data.get("best_streak"), 0))
        accuracy = round((correct_count / total_problems * 100.0), 2) if total_problems else 0.0
        avg_time = round(average([result["response_time"] for result in sanitized_results]), 3)
        session_duration = round(safe_float(data.get("session_duration"), 0.0), 3)
        time_limit = safe_int(data.get("time_limit"), 0) or None
        ended_early = safe_bool(data.get("ended_early"))
        summary = generate_session_summary(sanitized_results, accuracy, avg_time)

        previous_best = get_personal_best_avg_time()
        session = PracticeSession(
            mode=str(data.get("mode", "full")).strip().lower(),
            min_a=safe_int(data.get("min_a"), 1),
            max_a=safe_int(data.get("max_a"), 20),
            requested_size=safe_int(data.get("session_size"), total_problems),
            total_problems=total_problems,
            correct_count=correct_count,
            missed_count=missed_count,
            best_streak=best_streak,
            accuracy=accuracy,
            avg_time=avg_time,
            task_time_limit=time_limit,
            session_duration=session_duration,
            ended_early=ended_early,
            summary=summary,
        )
        db.session.add(session)
        db.session.flush()

        fast_threshold = (time_limit * 0.6) if time_limit else 4.0
        now = datetime.utcnow()

        for result in sanitized_results:
            db.session.add(
                SessionProblemResult(
                    session_id=session.id,
                    problem_key=result["problem_key"],
                    a=result["a"],
                    b=result["b"],
                    correct=result["correct"],
                    skipped=result["skipped"],
                    response_time=result["response_time"],
                )
            )

            stat = db.session.get(ProblemStat, result["problem_key"])
            if stat is None:
                stat = ProblemStat(
                    problem_key=result["problem_key"],
                    a=result["a"],
                    b=result["b"],
                    attempts=0,
                    correct_count=0,
                    missed_count=0,
                    total_time=0.0,
                    avg_time=0.0,
                    consecutive_fast_correct=0,
                    difficulty_score=1.25,
                )
                db.session.add(stat)

            stat.attempts += 1
            stat.total_time += result["response_time"]
            stat.avg_time = round(stat.total_time / stat.attempts, 3)
            stat.last_seen = now

            if result["correct"]:
                stat.correct_count += 1
                if result["response_time"] <= fast_threshold:
                    stat.consecutive_fast_correct += 1
                else:
                    stat.consecutive_fast_correct = 0
            else:
                stat.missed_count += 1
                stat.consecutive_fast_correct = 0

            stat.difficulty_score = calculate_difficulty(stat)

        db.session.commit()

        is_new_best = previous_best is None or (
            total_problems > 0 and avg_time < previous_best
        )

        return jsonify(
            {
                "session_id": session.id,
                "summary": summary,
                "is_new_best": bool(is_new_best),
                "personal_best_avg_time": get_personal_best_avg_time(),
                "home": home_payload(),
            }
        )


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)
