import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from main import _build_attendee_presence_warning


def test_build_attendee_presence_warning_detects_missing_attendee():
    registered_attendees = ["Alice", "Bob"]
    speaker_labels = ["Alice", "Carol"]
    warning = _build_attendee_presence_warning(registered_attendees, speaker_labels)

    assert warning is not None
    assert warning["type"] == "attendee_not_present_in_audio"
    assert warning["name"] == "Bob"


def test_build_attendee_presence_warning_skips_attendees_present_in_audio():
    registered_attendees = ["Alice", "Bob"]
    speaker_labels = ["Alice", "Bob"]
    warning = _build_attendee_presence_warning(registered_attendees, speaker_labels)

    assert warning is None
