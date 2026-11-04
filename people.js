const cleanHandle = value => String(value || '').trim().replace(/^@/, '').toLowerCase();
const validHandle = value => /^[a-z0-9_]{1,15}$/.test(value);
function personNotice(message, error = false) {
  const el = $('#personNotice');
  el.textContent = message;
  el.hidden = false;
  el.classList.toggle('error', error);
}

async function renderPeople() {
  const saved = await getAll('people');
  const query = $('#personSearch').value.trim().toLowerCase();
  const people = saved.filter(person => !query || [person.handle, person.label, person.note, person.match].join(' ').toLowerCase().includes(query)).sort((a,b) => Number(!!b.label) - Number(!!a.label) || a.handle.localeCompare(b.handle));
  $('#peopleList').innerHTML = people.length ? `<p class="muted">${people.length} 个账号${people.length > 100 ? '，仅显示前 100 个，请用搜索缩小范围' : ''}</p>` + people.slice(0,100).map(person => `
    <article class="person-row">
      <div><strong>${escapeHTML(person.label || `@${person.handle}`)}</strong><span>@${escapeHTML(person.handle)}${person.privateAccount ? '，私密账号' : ''}${person.match ? `，关联 @${escapeHTML(person.match)}` : ''}</span>${person.note ? `<p>${escapeHTML(person.note)}</p>` : ''}</div>
      <button type="button" class="ghost edit-person" data-handle="${escapeHTML(person.handle)}">编辑</button>
    </article>`).join('') : '<p class="muted">还没有整理过账号。先手动添加已确认的账号吧。</p>';
}

$('#personForm').addEventListener('submit', async event => {
  event.preventDefault();
  const handle = cleanHandle($('#personHandle').value);
  const match = cleanHandle($('#personMatch').value);
  if (!validHandle(handle) || (match && (!validHandle(match) || match === handle))) {
    personNotice('请检查账号名称和要关联的账号。', true); return;
  }
  await savePerson({
    handle,
    label:$('#personLabel').value.trim().slice(0,80),
    match,
    note:$('#personNote').value.trim().slice(0,500),
    privateAccount:$('#personPrivate').checked,
    updatedAt:new Date().toISOString()
  });
  $('#personForm').reset();
  $('#personHandle').readOnly = false;
  await renderPeople();
  await refresh();
  personNotice(`已将 @${handle} 的信息保存到此设备。`);
});

$('#peopleList').addEventListener('click', async event => {
  const button = event.target.closest('.edit-person');
  if (!button) return;
  const person = (await getAll('people')).find(item => item.handle === button.dataset.handle) || { handle:button.dataset.handle };
  $('#personHandle').value = person.handle;
  $('#personHandle').readOnly = true;
  $('#personLabel').value = person.label || '';
  $('#personMatch').value = person.match || '';
  $('#personNote').value = person.note || '';
  $('#personPrivate').checked = !!person.privateAccount;
  $('#personHandle').focus();
});
$('#personSearch').addEventListener('input', () => renderPeople().catch(error => personNotice(error.message, true)));

document.querySelector('.nav[data-view="people"]')?.addEventListener('click', () => renderPeople().catch(error => personNotice(error.message, true)));
if (view === 'people') renderPeople().catch(error => personNotice(error.message, true));

