"""
Unit tests for `renumber_citation_markers`, which rewrites a model's raw
[S<n>] source markers into sequential [1], [2]... markers that line up
with the position of that source in the final `citations` list returned
to the frontend. The frontend renders each surviving marker as a small
inline, hoverable citation chip.
"""
from app.services.rag_pipeline import renumber_citation_markers, _parse_cited_source_numbers


def test_renumbers_markers_to_citation_list_positions():
    raw = "Revenue grew 20% [S2]. Costs also rose [S1]."
    cited = _parse_cited_source_numbers(raw)  # -> [1, 2]
    assert cited == [1, 2]

    result = renumber_citation_markers(raw, cited)

    # Source 1 is the first entry in `cited`, so [S1] -> [1].
    # Source 2 is the second entry in `cited`, so [S2] -> [2].
    assert result == "Revenue grew 20% [2]. Costs also rose [1]."


def test_drops_markers_for_sources_outside_the_resolved_set():
    raw = "See figure one [S1] and an unresolved reference [S9]."
    result = renumber_citation_markers(raw, cited_numbers=[1])
    assert result == "See figure one [1] and an unresolved reference ."


def test_no_markers_present_is_a_no_op():
    raw = "A plain answer with no citations at all."
    assert renumber_citation_markers(raw, cited_numbers=[]) == raw


def test_repeated_marker_for_the_same_source_renumbers_consistently():
    raw = "Point one [S3]. Point two, same source [S3] again."
    result = renumber_citation_markers(raw, cited_numbers=[3])
    assert result == "Point one [1]. Point two, same source [1] again."
