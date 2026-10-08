#!/usr/bin/env python3
"""Real Chromium regression with fully intercepted I/O. No live DB or sends.
Run: python3 tests/review-browser.py (requires Playwright and Chrome).
"""
import json
from copy import deepcopy
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
fixtures = json.loads((ROOT/'tests/fixtures/review-scripts.json').read_text())
single=deepcopy(fixtures[0]); single['id']='11111111-1111-4111-8111-111111111111'; single['name']='Single useful answer'; single['scenario_slug']='d_single'; single['segments']=single['segments'][:1]
single['segments'][0].update(run_id=single['id'],draft_id='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333')
fixtures.append(single)
account = dict(id='acct', label='Fixture Team', active=True, disclosed=True, usable=True, disclosure_line='(Geonode team here)')
runs = [dict(id=f['id'], scenario_slug=f['scenario_slug'], subreddit='testing', thread_id='fixture',
             status='open', review_status='pending', effective_review_status='pending', segment_count=len(f['segments']),
             account_id='acct', started_at='2026-10-01T00:00:00Z') for f in fixtures]
scenarios = [dict(slug=f['scenario_slug'], name=f['name'], enabled=True, same_thread_accounts=False,
                  spec={'acts':f['segments']}) for f in fixtures]
acts = [a for f in fixtures for a in f['segments']]
segments = [dict(id=a['draft_id'], body=a['body'], kind=a['kind'], mode='scenario', status='pending', thread_id='fixture') for a in acts]
comments = [dict(id=f'comment{i}', body='A standalone test comment. (Geonode team here)', kind='comment', mode='comment',
                 status='pending', thread_id='fixture', subreddit='testing', account_id='acct' if i < 10 else None,
                 created_at='2026-10-01T00:00:00Z') for i in range(11)]
mutations=[]; errors=[]; batch_failure=True
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, channel='chrome')
    page=browser.new_page(viewport={'width':1280, 'height':1000})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d:d.accept('test-operator') if d.type=='prompt' else d.accept())
    def route(r):
        global batch_failure
        u=urlparse(r.request.url); q=parse_qs(u.query)
        if '/rest/v1/' in u.path or u.path=='/api/operator':
            name=('rpc/'+r.request.post_data_json['rpc']) if u.path=='/api/operator' else u.path.split('/rest/v1/')[1]; data=[]
            if r.request.method=='POST':
                assert u.path=='/api/operator', 'Browser attempted a direct database mutation'
                assert r.request.headers.get('authorization')=='Bearer test-operator'
                payload=r.request.post_data_json['args']; mutations.append((name,payload))
                if name=='rpc/approve_draft_batch':
                    if batch_failure:
                        batch_failure=False
                        return r.fulfill(status=400,content_type='application/json',body=json.dumps({'message':'fixture approval error'}))
                    ids=payload['p_draft_ids']; data=[dict(draft_id=x,error=None) for x in ids]
                    comments[:]=[d for d in comments if d['id'] not in ids]
                elif name=='rpc/review_script_segment':
                    d=next(d for d in segments if d['id']==payload['p_draft_id'])
                    if payload['p_action']=='edit': d['body']=payload['p_body']; d['status']='edited'
                    else: d['status']='approved' if payload['p_action']=='approve' else 'rejected'
                    data=d
                elif name=='rpc/review_scenario_run':
                    data=next(d for d in runs if d['id']==payload['p_run_id'])
                    data['review_status']=data['effective_review_status']='approved' if payload['p_action']=='approve' else 'rejected'
                else: raise AssertionError('Unexpected RPC: '+name)
            elif name=='drafts':
                if q.get('select')==['id']: data=[{'id':'probe'}]
                elif 'id' in q: data=segments
                elif 'status.eq.posted' in q.get('or',[''])[0] or q.get('status')==['in.(approved,dispatched,posted,cancelled,removed)']: data=[]
                else: data=deepcopy(comments+segments)
            elif name=='scenario_acts': data=acts
            elif name=='script_review_state': data=runs
            elif name=='scenarios': data=scenarios
            elif name=='accounts': data=[account]
            elif name=='rule_checks': data=[dict(draft_id=d['id'],verdict='skipped' if d['id']=='comment0' else 'pass',removal_risk=None if d['id']=='comment0' else 10) for d in comments]
            elif name=='thread_activity': data=[dict(thread_id='fixture',title='Test narrative',subreddit='testing',stage='draft_pending_review',mode='scenario')]
            return r.fulfill(status=200,content_type='application/json',body=json.dumps(data))
        if u.path=='/api/dispatch':
            assert r.request.headers.get('authorization')=='Bearer test-operator'
            mutations.append(('dispatch',{})); return r.fulfill(content_type='application/json',body='{"results":[]}')
        if u.path=='/assets/config.js':
            return r.fulfill(content_type='application/javascript',body="window.SB_URL='https://fixture.test';window.SB_KEY='fixture';")
        if u.path=='/assets/gate.js': return r.fulfill(content_type='application/javascript',body='')
        local=ROOT/u.path.lstrip('/')
        if not local.suffix: local=local.with_suffix('.html')
        if u.netloc=='fixture.test' and local.is_file(): return r.fulfill(path=str(local))
        r.fulfill(status=200,body='')
    page.route('**/*',route)
    page.goto('https://fixture.test/review.html')
    expect(page.locator('.batch-row')).to_have_count(11)
    expect(page.locator('.scenario-card')).to_have_count(len(fixtures))
    all_box=page.locator('#batch-select-all'); all_box.check()
    expect(page.locator('#batch-count')).to_have_text('10')
    page.locator('#batch-approve-btn').click()
    expect(page.locator('#batch-status')).to_be_visible()
    expect(page.locator('#batch-status')).to_contain_text('fixture approval error')
    page.locator('#batch-approve-btn').click()
    expect(page.locator('.batch-row')).to_have_count(1)
    expect(all_box).to_be_disabled()
    for f in fixtures:
        card=page.locator(f'.scenario-card[data-run-id="{f["id"]}"]')
        card.locator('summary').click()
        expect(card.locator('.scenario-act')).to_have_count(len(f['segments']))
        card.locator('[data-segment-body]').first.fill('Edited fixture. (Geonode team here)')
        card.locator('[data-a=approve-run]').click()
        expect(card.locator('[data-s]')).to_contain_text('Save segment edits')
        card.locator('[data-segment-action=edit]').first.click()
        expect(card.locator('[data-s]')).to_contain_text('Segment review saved')
        card.locator('[data-segment-action=approve]').first.click()
        expect(card.locator('.status-badge').first).to_contain_text('approved')
        card.locator('[data-a=approve-run]').click()
        expect(card.locator('.badges')).to_contain_text('script approved')
    page.goto('https://fixture.test/status.html')
    links=page.locator('a[href*="review?script="]'); expect(links).to_have_count(len(fixtures))
    links.first.click()
    target=page.locator(f'#script-{fixtures[0]["id"]} details')
    expect(target).to_have_attribute('open','')
    assert not errors, errors
    assert len([m for m in mutations if m[0]=='dispatch'])==1
    page.screenshot(path='/tmp/review-script-regression.png',full_page=True)
    print('PASS: select all, visible error, retry, grouped 4/5/3 narratives, single-act approval, skipped scoring visible, operator authorization, segment review, script review, status drill-down')
    browser.close()
