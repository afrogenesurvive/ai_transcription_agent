import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routes.labeling import _build_attendee_presence_warning, _build_voiceprint_reuse_warnings


def test_build_attendee_presence_warning_detects_missing_attendee():
    form_attendees = ["Alice", "Bob"]
    matched = ["Alice"]
    enrolled = ["Alice", "Bob"]
    warnings = _build_attendee_presence_warning(form_attendees, matched, enrolled)

    assert len(warnings) == 1
    assert warnings[0]["type"] == "attendee_not_present_in_audio"
    assert warnings[0]["name"] == "Bob"
    assert "registered voiceprint" in warnings[0]["message"]


def test_build_attendee_presence_warning_skips_attendees_present_in_audio():
    form_attendees = ["Alice", "Bob"]
    matched = ["Alice", "Bob"]
    enrolled = ["Alice", "Bob"]
    warnings = _build_attendee_presence_warning(form_attendees, matched, enrolled)

    assert warnings == []


def test_build_attendee_presence_warning_reports_all_unmatched():
    form_attendees = ["Alice", "Bob", "Carol"]
    matched = ["Alice"]
    enrolled = ["Alice", "Bob", "Carol"]
    warnings = _build_attendee_presence_warning(form_attendees, matched, enrolled)

    assert [w["name"] for w in warnings] == ["Bob", "Carol"]


def test_build_attendee_presence_warning_excludes_unregistered_attendees():
    # Brand-new attendees with no enrolled voiceprint are NOT flagged.
    form_attendees = ["Alice", "NewGuy", "Bob"]
    matched = ["Alice"]
    enrolled = ["Alice", "Bob"]
    warnings = _build_attendee_presence_warning(form_attendees, matched, enrolled)

    assert [w["name"] for w in warnings] == ["Bob"]


def test_build_attendee_presence_warning_flags_registered_but_voiceprint_unmatched():
    # A registered attendee whose voiceprint wasn't matched in the audio is
    # flagged even if their name was used as a label (whitespace-insensitive).
    form_attendees = ["test 011"]
    matched = ["SomeoneElse"]
    enrolled = ["test011"]
    warnings = _build_attendee_presence_warning(form_attendees, matched, enrolled)

    assert len(warnings) == 1
    assert warnings[0]["name"] == "test 011"


def test_build_voiceprint_reuse_warnings_flags_cross_job_reuse():
    warnings = _build_voiceprint_reuse_warnings(
        entries=[{"name": "Sags", "email": "sags@example.com"}],
        current_job_id="job-003",
        voiceprints=[
            {
                "name": "Sags",
                "email": "sags@example.com",
                "sample_job_id": "job-002",
            }
        ],
    )

    assert len(warnings) == 1
    assert warnings[0]["type"] == "voiceprint_reused_from_other_job"
    assert warnings[0]["sample_job_id"] == "job-002"


def test_build_voiceprint_reuse_warnings_ignores_same_job_reuse():
    warnings = _build_voiceprint_reuse_warnings(
        entries=[{"name": "Sags", "email": "sags@example.com"}],
        current_job_id="job-003",
        voiceprints=[
            {
                "name": "Sags",
                "email": "sags@example.com",
                "sample_job_id": "job-003",
            }
        ],
    )

    assert warnings == []
