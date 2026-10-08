from server.routing import UserRouting, compute_recipients, contains_keyword, extract_topics


def user(uid, **kwargs):
    return UserRouting(uid, kwargs.get("disabled", False), kwargs.get("topics_mode", "all"),
                       kwargs.get("topics", []), kwargs.get("blacklist", []), kwargs.get("admin_blacklist", []))


def test_topic_extraction():
    assert extract_topics("#deploy done # Heading a#b page#frag #中文话题 #a-b- #Deploy") == [
        ("deploy", "deploy"), ("中文话题", "中文话题"), ("a-b", "a-b")]
    assert extract_topics(None) == []


def test_routing_filters_and_union():
    users = [user(1), user(2, topics_mode="only", topics=["#DEPLOY"]),
             user(3, topics_mode="only", topics=["other"]), user(4, disabled=True),
             user(5, blacklist=["SECRET"]), user(6, admin_blacklist=["report.pdf"])]
    assert contains_keyword("SeCrEt", [" secret "])
    assert compute_recipients("hello", None, [], users, {}) == [1, 5, 6]
    assert compute_recipients("secret", "report.pdf", ["deploy"], users, {}) == [1, 2]
    assert compute_recipients("hello", None, ["deploy", "other"], users, {"deploy": [2, 3, 4], "other": [1, 5]}) == [1, 2, 3, 5]
    assert compute_recipients("secret", None, ["deploy"], users, {"deploy": [3, 5]}) == [3]
