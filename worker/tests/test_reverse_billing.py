from types import SimpleNamespace
from unittest.mock import MagicMock
import sys
from pathlib import Path
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from motion_worker.reverse_billing import ProviderCreditError, check_billing, record_credit_stop


@pytest.mark.parametrize('status,body,blocked',[
    (402,{},True),(403,{'detail':'User is locked. Reason: Exhausted balance.'},True),
    (429,{'error':{'code':'insufficient_quota'}},True),(429,{'error':{'code':'rate_limit_exceeded'}},False),
    (403,{'error':{'code':'access_denied'}},False),(503,{},False)])
def test_explicit_credit_rejection_is_separate_from_other_http_failures(status,body,blocked):
    response=SimpleNamespace(status_code=status,json=lambda:body)
    if blocked:
        with pytest.raises(ProviderCreditError,match='เครดิต') as e:check_billing(response,'fal.ai',before_acceptance=True)
        assert e.value.before_acceptance
    else:check_billing(response,'fal.ai',before_acceptance=True)


@pytest.mark.parametrize('accepted',[True,False])
def test_only_a_definite_preacceptance_rejection_releases_its_own_claim(accepted):
    ctx=MagicMock();ctx.job={'id':'job'}
    record_credit_stop(ctx,ProviderCreditError('OpenAI',not accepted),'cache','slot')
    queries=ctx.db.conn.execute.call_args_list
    assert any('_reverse_credit' in q.args[0] for q in queries)
    drops=[q for q in queries if 'DELETE FROM creative_cache' in q.args[0]]
    if accepted:assert not drops
    else:assert len(drops)==1 and drops[0].args[1]==('cache','job')
