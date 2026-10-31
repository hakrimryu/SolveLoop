from app.ai.config import AISettings
from app.ai.knowledge import PROFILE_ID, SPECIFICATION
from app.knowledge import get_document, get_version
from app.knowledge_search import compute, register_profile, search_state, snapshot, store
from app.models import KnowledgeSearchState


class FixtureEmbeddings:
    """GPU不要の固定応答。実モデルの検索品質は検証しない。"""

    settings = AISettings()

    def embed(self, value, **options):
        return {
            "local_model": {"name": SPECIFICATION["model"], "digest": SPECIFICATION["digest"]},
            "embeddings": [[1.0] + [0.0] * 767],
            "prompt_eval_count": 12,
        }


def initialize_search(session):
    register_profile(session)
    state = session.get(KnowledgeSearchState, 1)
    if state is None:
        session.add(KnowledgeSearchState(id=1, revision=1, active_profile_id=PROFILE_ID))
    else:
        state.active_profile_id = PROFILE_ID
    session.flush()


def prepare_fixture(session, version):
    doc = get_document(session, version["document_id"])
    saved = get_version(session, version["document_id"], version["version_no"])
    value = snapshot(session, doc, saved, search_state(session))
    store(session, value, compute(FixtureEmbeddings(), value))
