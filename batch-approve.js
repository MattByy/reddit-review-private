// Batch approve logic for review.html
// Insert this after renderScenarios function and before the boot() call

let batchMode = false;
let batchSelected = new Set();

function showBatchMode(show) {
  batchMode = show;
  const batch = document.getElementById('batch-section');
  const ws = document.getElementById('ws');
  if (batch) batch.hidden = !show;
  if (ws) ws.hidden = show;
  if (show) {
    renderBatchGrid();
  } else {
    batchSelected.clear();
  }
}

function renderBatchGrid() {
  const grid = document.getElementById('batch-grid');
  const selectAll = document.getElementById('batch-select-all');
  if (!grid || !selectAll) return;
  
  grid.innerHTML = drafts.map((d, i) => {
    const c = checks[d.id];
    const isSelected = batchSelected.has(d.id);
    const canApprove = !(d.gate_failed_at || d.redirect_pending || 
      (d.kind === 'reply' && !d.scenarioContext?.self_reply && !d.parent_confirmed_by));
    const chipVal = stateChip(d) || scoreChip(c);
    return `<div class="batch-row${!canApprove ? ' error' : ''}">
      <input type="checkbox" data-draft-id="${esc(d.id)}" ${isSelected ? 'checked' : ''} ${!canApprove ? 'disabled' : ''}>
      <div>
        <div class="title">${esc(cleanTitle(threadTitle(d)))}</div>
        <div class="sub">r/${esc(threadSub(d) || '?')}</div>
      </div>
      <div>${esc(d.kind === 'post' ? 'post' : d.kind === 'reply' ? 'reply' : 'comment')}</div>
      <div>${stratChip(d)}</div>
      <div class="badge-slot">${chipVal}</div>
    </div>`;
  }).join('');
  
  grid.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.draftId;
      if (cb.checked) {
        batchSelected.add(id);
      } else {
        batchSelected.delete(id);
      }
      updateBatchUI();
    });
  });
  
  selectAll.addEventListener('change', () => {
    grid.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => {
      cb.checked = selectAll.checked;
      const id = cb.dataset.draftId;
      if (selectAll.checked) {
        batchSelected.add(id);
      } else {
        batchSelected.delete(id);
      }
    });
    updateBatchUI();
  });
  
  const total = document.getElementById('batch-total');
  if (total) total.textContent = drafts.length;
  updateBatchUI();
}

function updateBatchUI() {
  const count = document.getElementById('batch-count');
  const btn = document.getElementById('batch-approve-btn');
  const selectAll = document.getElementById('batch-select-all');
  
  if (count) count.textContent = batchSelected.size;
  if (btn) btn.disabled = batchSelected.size === 0;
  
  if (selectAll) {
    const grid = document.getElementById('batch-grid');
    if (grid) {
      const checkboxes = Array.from(grid.querySelectorAll('input[type=checkbox]:not(:disabled)'));
      selectAll.indeterminate = batchSelected.size > 0 && batchSelected.size < checkboxes.length;
      selectAll.checked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
    }
  }
}

// Event listeners
const batchCancel = document.getElementById('batch-cancel');
if (batchCancel) {
  batchCancel.addEventListener('click', () => showBatchMode(false));
}

const batchApproveBtn = document.getElementById('batch-approve-btn');
if (batchApproveBtn) {
  batchApproveBtn.addEventListener('click', async () => {
    if (batchSelected.size === 0) return;
    const draftIds = Array.from(batchSelected);
    const status = document.getElementById('batch-status');
    if (!status) return;
    
    status.hidden = false;
    status.classList.remove('bad', 'ok', 'warn');
    status.classList.add('info');
    status.querySelector('.body').innerHTML = `Approving ${draftIds.length} draft${draftIds.length === 1 ? '' : 's'}…`;
    batchApproveBtn.disabled = true;
    
    try {
      const results = await rpc('approve_draft_batch', {
        p_draft_ids: draftIds,
        p_note: 'Batch approved by reviewer',
        p_editor: 'reviewer'
      });
      
      // Check for errors in the batch
      const withErrors = results.filter(r => r.error);
      const successful = results.filter(r => !r.error);
      
      if (successful.length > 0) {
        // Remove approved drafts from the list
        drafts = drafts.filter(d => !successful.some(r => r.draft_id === d.id));
        batchSelected.clear();
        setCounts();
        await Promise.all([renderSend()]);
        
        let msg = `Approved ${successful.length} draft${successful.length === 1 ? '' : 's'}.`;
        if (withErrors.length > 0) {
          msg += ` ${withErrors.length} had issues: ${withErrors.map(r => r.error).join('; ')}`;
        }
        status.classList.remove('info');
        status.classList.add(withErrors.length > 0 ? 'warn' : 'ok');
        status.querySelector('.body').innerHTML = `${ICON.check}<div class="body" style="margin-left:0">${esc(msg)}</div>`;
        
        flash(`Approved ${successful.length}. Sending to Engain…`);
        const res = await dispatch();
        flash(describe(res));
        
        if (!drafts.length) {
          showBatchMode(false);
          showEmpty();
        } else {
          renderBatchGrid();
        }
      } else {
        throw new Error(withErrors.map(r => r.error).join('; '));
      }
    } catch (e) {
      status.classList.remove('info');
      status.classList.add('bad');
      status.querySelector('.body').innerHTML = `${ICON.x}<div class="body" style="margin-left:0">Failed: ${esc(errText(e))}</div>`;
      batchApproveBtn.disabled = false;
    }
  });
}
