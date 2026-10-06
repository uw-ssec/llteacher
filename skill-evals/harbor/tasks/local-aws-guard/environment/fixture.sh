. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
$G -C "$REPO" tag fixture-base
mkdir -p /fixture/docker /fixture/npm && touch /fixture/docker/down /fixture/npm/docker-down
finish_fixture
