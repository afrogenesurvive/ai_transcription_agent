import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routes.labeling import _build_attendee_presence_warning, _build_voiceprint_reuse_warnings


def test_build_attendee_presence_warning_detects_missing_attendee():
    registered_attendees = ["Alice", "Bob"]
    speaker_labels = ["Alice", "Carol"]
    warnings = _build_attendee_presence_warning(registered_attendees, speaker_labels)

    assert len(warnings) == 1
    assert warnings[0]["type"] == "attendee_not_present_in_audio"
    assert warnings[0]["name"] == "Bob"


def test_build_attendee_presence_warning_skips_attendees_present_in_audio():
    registered_attendees = ["Alice", "Bob"]
    speaker_labels = ["Alice", "Bob"]
    warnings = _build_attendee_presence_warning(registered_attendees, speaker_labels)

    assert warnings == []


def test_build_attendee_presence_warning_reports_all_unmatched():
    registered_attendees = ["Alice", "Bob", "Carol"]
    speaker_labels = ["Alice"]
    warnings = _build_attendee_presence_warning(registered_attendees, speaker_labels)

    assert [w["name"] for w in warnings] == ["Bob", "Carol"]


def test_build_voiceprint_reuse_warnings_flags_cross_job_reuse():
    warnings = _build_voiceprint_reuse_warnings(
        entries=[{"name": "Sags", "email": "african.genetic.survival@gmail.com"}],
        current_job_id="job-003",
        voiceprints=[
            {
                "name": "Sags",
                "email": "african.genetic.survival@gmail.com",
                "sample_job_id": "job-002",
            }
        ],
    )

    assert len(warnings) == 1
    assert warnings[0]["type"] == "voiceprint_reused_from_other_job"
    assert warnings[0]["sample_job_id"] == "job-002"


def test_build_voiceprint_reuse_warnings_ignores_same_job_reuse():
    warnings = _build_voiceprint_reuse_warnings(
        entries=[{"name": "Sags", "email": "african.genetic.survival@gmail.com"}],
        current_job_id="job-003",
        voiceprints=[
            {
                "name": "Sags",
                "email": "african.genetic.survival@gmail.com",
                "sample_job_id": "job-003",
            }
        ],
    )

    assert warnings == []
