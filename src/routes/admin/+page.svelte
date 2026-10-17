<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';

  type Settings = { collectionName: string; photoRoot: string; immichUrl: string; immichLibraryId: string; immichPhotoRoot: string; immichApiKey: string; immichScanApiKey: string };
  type Member = { id: string; name: string; folder: string; active: number; shared: number };
  type Overview = { settings: Omit<Settings, 'immichApiKey' | 'immichScanApiKey'>; automaticImmichPath: boolean; allowedRoot: string; basePath: string; origin: string; previewKeyConfigured: boolean; scanKeyConfigured: boolean; sharedLinkActive: boolean; members: Member[] };
  let loading = true, authenticated = false, configured = false, busy = false;
  let password = '', setupToken = '', error = '', notice = '', generatedLink = '';
  let overview: Overview | undefined;
  let settings: Settings = { collectionName: '', photoRoot: '', immichUrl: '', immichLibraryId: '', immichPhotoRoot: '', immichApiKey: '', immichScanApiKey: '' };
  let confirmFolderChange = false;
  let browserOpen = false, browsingFolder = '', directories: string[] = [];
  let memberName = '', memberFolder = '', copied = false;
  let tab: 'collection' | 'access' = 'collection';
  function folderLabel(folder: string) { return overview ? folder.slice(overview.allowedRoot.length).replace(/^\//, '') || 'Available folders' : folder; }
  $: changedFolder = !!overview && settings.photoRoot !== overview.settings.photoRoot;
  $: dirty = !!overview && (Object.entries(overview.settings).some(([key, value]) => settings[key as keyof Settings] !== value) || !!settings.immichApiKey || !!settings.immichScanApiKey);

  function selectTab(value: 'collection' | 'access') {
    if (value === 'access' && dirty) { error = 'Save your collection settings before creating invitations.'; return; }
    error = ''; tab = value;
  }

  async function request(endpoint: string, body?: object) {
    const response = await fetch(`${base}/api/admin/${endpoint}`, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    } : undefined);
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && endpoint !== 'session') authenticated = false;
      throw new Error(result.error || 'The request could not be completed.');
    }
    return result;
  }

  function apply(result: Overview) {
    overview = result;
    settings = { ...result.settings, immichApiKey: '', immichScanApiKey: '' };
    confirmFolderChange = false;
  }

  async function signIn(event: SubmitEvent) {
    event.preventDefault(); busy = true; error = '';
    try {
      await request('session', { action: configured ? 'login' : 'setup', password, token: setupToken });
      password = ''; setupToken = ''; configured = true; authenticated = true;
      apply(await request('config'));
    } catch (cause) { error = (cause as Error).message; if (!overview) authenticated = false; }
    finally { busy = false; }
  }

  async function action(name: string, extra: object = {}) {
    busy = true; error = ''; notice = ''; copied = false;
    try {
      const result = await request('config', { action: name, ...extra });
      if (name === 'save' && changedFolder) generatedLink = '';
      if (result.settings) apply(result);
      if (result.link) generatedLink = result.link;
      if (name === 'revoke-share') generatedLink = '';
      notice = result.message || (result.link ? 'Invitation ready. Copy it below.' : 'Done.');
      if (name === 'create-member') { memberName = ''; memberFolder = ''; }
    } catch (cause) { error = (cause as Error).message; if (!overview) authenticated = false; }
    finally { busy = false; }
  }

  async function browse(folder: string) {
    error = '';
    try {
      const result = await request(`config?folder=${encodeURIComponent(folder)}`);
      browsingFolder = result.folder; directories = result.directories; browserOpen = true;
    } catch (cause) { error = (cause as Error).message; }
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(generatedLink); copied = true; }
    catch { notice = 'Select the invitation below and copy it.'; }
  }

  onMount(async () => {
    setupToken = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
    if (setupToken) history.replaceState(null, '', location.pathname + location.search);
    try {
      const session = await request('session');
      configured = session.configured; authenticated = session.authenticated;
      if (authenticated) apply(await request('config'));
    } catch (cause) { error = (cause as Error).message; if (!overview) authenticated = false; }
    finally { loading = false; }
  });
</script>

<svelte:head><title>Manage collection · Gather</title><meta name="robots" content="noindex,nofollow" /></svelte:head>

<div class="admin-shell">
  <header class="admin-header">
    <a class="wordmark" href={`${base}/`}>gather<span>.</span></a>
    <span class="admin-label">Collection settings</span>
    {#if authenticated}<button class="quiet" on:click={async () => { await request('session', { action: 'logout' }); authenticated = false; overview = undefined; generatedLink = ''; }}>Sign out</button>{/if}
  </header>

  {#if loading}<main class="sign-in"><p>Loading your collection…</p></main>
  {:else if !authenticated}
    <main class="sign-in">
      <span class="eyebrow">For the host</span>
      <h1>{configured ? 'Welcome back.' : 'Make it yours.'}</h1>
      <p>{configured ? 'Sign in to choose your photos, connect Immich, and manage who can join.' : 'Create your administrator password to start managing this collection.'}</p>
      <form on:submit={signIn}>
        {#if !configured}<label>Private setup token<input aria-label="Private setup token" type="password" autocomplete="off" bind:value={setupToken} required /><small>Included in the private setup link supplied by your server administrator.</small></label>{/if}
        <label>Administrator password<input aria-label="Administrator password" type="password" autocomplete={configured ? 'current-password' : 'new-password'} minlength={configured ? undefined : 12} maxlength="256" bind:value={password} required /><small>{configured ? 'This is separate from your Immich account.' : 'Use at least 12 characters. Guests never need this password.'}</small></label>
        {#if error}<p class="alert error" role="alert">{error}</p>{/if}
        <button class="primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : configured ? 'Sign in' : 'Create administrator'}</button>
      </form>
      <a class="back" href={`${base}/`}>← Back to the collection</a>
    </main>
  {:else if overview}
    <main class="dashboard">
      <div class="intro"><div><span class="eyebrow">A place for everyone’s photos</span><h1>Your collection, your way.</h1><p>Choose what you share, then invite your people.</p></div><a class="button secondary" href={`${base}/`}>Open collection ↗</a></div>
      <nav aria-label="Settings sections"><button class:chosen={tab === 'collection'} on:click={() => selectTab('collection')}>Shared folder</button><button class:chosen={tab === 'access'} on:click={() => selectTab('access')}>People & invitations</button></nav>
      {#if error}<p class="alert error" role="alert">{error}</p>{/if}
      {#if notice}<p class="alert success" role="status">{notice}</p>{/if}

      {#if tab === 'collection'}
        <form on:submit|preventDefault={() => action('save', { settings, confirmFolderChange })}>
          <section class="card">
            <div class="section-heading"><span class="step">01</span><div><h2>The collection</h2><p>Everything inside this folder is visible to everyone you invite.</p></div></div>
            <label>Collection name<input bind:value={settings.collectionName} maxlength="120" required placeholder="A weekend worth remembering" /></label>
            <div class="collection-choice"><span class="eyebrow">Sharing now</span><h2>{folderLabel(settings.photoRoot)}</h2><p>Your photos stay in this folder. Guests can browse and download everything inside it, and upload into their personal subfolder.</p><button type="button" class="secondary" on:click={() => browse(overview!.allowedRoot)}>Choose a different folder</button></div>
            {#if browserOpen}<div class="folder-browser"><div class="folder-heading"><strong>{folderLabel(browsingFolder)}</strong><button type="button" class="quiet" on:click={() => browserOpen = false}>Close</button></div>{#if browsingFolder !== overview.allowedRoot}<button type="button" class="folder" on:click={() => browse(browsingFolder.slice(0, browsingFolder.lastIndexOf('/')))}>↑ Parent folder</button>{/if}{#each directories as directory}<button type="button" class="folder" on:click={() => browse(`${browsingFolder}/${directory}`)}>▱ {directory}<span>→</span></button>{/each}{#if !directories.length}<p class="muted">No subfolders.</p>{/if}<button type="button" class="primary" on:click={() => { settings.photoRoot = browsingFolder; browserOpen = false; }}>Use this folder</button></div>{/if}
            {#if changedFolder}<label class="confirmation"><input type="checkbox" bind:checked={confirmFolderChange} required /><span>I understand changing folders signs out all guests and removes their invitations. Photos are preserved.</span></label>{/if}
          </section>
          <details class="card integration"><summary>Server integration <span>Optional setup for previews</span></summary>
            <div class="section-heading"><span class="step">02</span><div><h2>Previews from Immich</h2><p>Gather keeps your originals. Immich supplies the thumbnails and larger previews.</p></div></div>
            <label>Immich server address<input type="url" bind:value={settings.immichUrl} placeholder="http://immich-server:2283" /><small>Use an address reachable from the Gather server.</small></label>
            <div class="two-columns"><label>External library ID<input bind:value={settings.immichLibraryId} placeholder="Library UUID" /></label><label>Collection path inside Immich<input bind:value={settings.immichPhotoRoot} disabled={overview.automaticImmichPath} placeholder="/external/gather" /><small>{overview.automaticImmichPath ? 'Mapped automatically when you choose a folder.' : 'The collection path as seen by Immich.'}</small></label></div>
            <div class="two-columns"><label>Preview API key<input type="password" autocomplete="new-password" bind:value={settings.immichApiKey} placeholder={overview.previewKeyConfigured ? 'Saved securely · leave blank to keep' : 'Paste API key'} /><small>Library owner’s key with asset.read and asset.view.</small></label><label>Scan API key <span class="optional">optional</span><input type="password" autocomplete="new-password" bind:value={settings.immichScanApiKey} placeholder={overview.scanKeyConfigured ? 'Saved securely · leave blank to keep' : 'Uses preview key when empty'} /><small>Administrator key with library.update.</small></label></div>
            <div class="note">The two folder paths must point to the same originals. Uploads scan the selected shared folder through the Gather folder-scan API extension. Other folders in the library are left alone.</div>
            <div class="actions"><button type="button" class="secondary" disabled={busy} on:click={() => action('test-immich')}>Test saved connection</button><button type="button" class="quiet" disabled={busy} on:click={() => action('scan')}>Scan selected folder</button></div>
          </details>
          <div class="save-bar"><p>Save your choice, then open People & invitations to share it.</p><button class="primary" type="submit" disabled={busy || (changedFolder && !confirmFolderChange)}>{busy ? 'Saving…' : 'Save settings'}</button></div>
        </form>
        <p class="deployment">Published at <a href={`${base}/`}>{overview.origin}{overview.basePath}/</a>.</p>
      {:else}
        <section class="card">
          <div class="section-heading"><span class="step">↗</span><div><h2>One link for the group</h2><p>Friends enter their name and get a personal upload folder. Everyone can browse and download the collection.</p></div><span class:active={overview.sharedLinkActive} class="status">{overview.sharedLinkActive ? 'Active' : 'Off'}</span></div>
          <div class="actions">{#if overview.sharedLinkActive}<button class="primary" disabled={busy} on:click={() => { if (confirm('Replace the group link and sign out its guests? Existing photos stay in place.')) action('rotate-share'); }}>Replace shared link</button><button class="danger" disabled={busy} on:click={() => { if (confirm('Revoke the shared link and sign out its guests?')) action('revoke-share'); }}>Revoke shared link</button>{:else}<button class="primary" disabled={busy} on:click={() => action('create-share')}>Create shared link</button>{/if}</div>
          <p class="muted">Anyone holding the link can join. Links are stored as hashes, so an existing link can only be replaced, not displayed again.</p>
        </section>
        {#if generatedLink}<section class="card invitation"><h2>Your invitation is ready.</h2><p>Copy it now and keep it somewhere private. It cannot be retrieved later.</p><div class="input-row"><input aria-label="Generated invitation link" readonly value={generatedLink} on:focus={(event) => event.currentTarget.select()} /><button class="primary" on:click={copyLink}>{copied ? 'Copied ✓' : 'Copy link'}</button></div><a href={generatedLink} target="_blank" rel="noreferrer">Open invitation ↗</a></section>{/if}
        <section class="card">
          <div class="section-heading"><span class="step">＋</span><div><h2>A personal invitation</h2><p>Give someone upload access to a specific folder. They can still view and download the whole collection.</p></div></div>
          <form on:submit|preventDefault={() => action('create-member', { name: memberName, folder: memberFolder })}><div class="two-columns"><label>Display name<input bind:value={memberName} required maxlength="80" placeholder="Niels" /></label><label>Upload folder<input aria-label="Upload folder" bind:value={memberFolder} required pattern={'[A-Za-z0-9][A-Za-z0-9-]{0,47}'} maxlength="48" placeholder="Niels" /><small>Use an existing folder or create a new one. Letters, digits, and hyphens only.</small></label></div><button class="secondary" type="submit" disabled={busy}>Create personal invitation</button></form>
        </section>
        <section class="card"><h2>People with access</h2><p class="muted">Revoking access preserves their folder and all originals. A revoked guest can rejoin with an active shared link.</p>{#if !overview.members.length}<div class="empty">Your people will appear here when they join.</div>{/if}{#each overview.members as member}<div class="member"><span class="avatar">{member.name.slice(0, 1).toUpperCase()}</span><div class="member-name"><strong>{member.name}</strong><small>{member.folder}/ · {member.active ? member.shared ? 'Shared link' : 'Personal invitation' : 'Revoked'}</small></div><button class="quiet" disabled={busy} on:click={() => { if (confirm(`Create a replacement invitation for ${member.name} and sign out their current sessions?`)) action('rotate-member', { folder: member.folder }); }}>New invitation</button>{#if member.active}<button class="danger" disabled={busy} on:click={() => { if (confirm(`Revoke access for ${member.name}? Their photos will be preserved.`)) action('revoke-member', { folder: member.folder }); }}>Revoke</button>{/if}</div>{/each}</section>
      {/if}
    </main>
  {/if}
</div>

<style>
  .collection-choice{background:#f7f8f3;border:1px solid #e4e9db;border-radius:10px;padding:24px;margin:24px 0 8px}.collection-choice h2{margin-top:12px}.collection-choice p{max-width:620px}.integration summary{cursor:pointer;font-size:14px;font-weight:600;list-style:none}.integration summary span{display:block;font-size:11px;font-weight:400;color:#899080;margin-top:5px}.integration[open] summary{margin-bottom:28px}
  .admin-shell{min-height:100vh;background:#f6f7f5;color:#263a35;font-family:Inter,system-ui,sans-serif}.admin-header{height:84px;display:flex;align-items:center;gap:26px;max-width:1160px;margin:auto;padding:0 32px;border-bottom:1px solid #dfe5df}.wordmark{font-size:32px;font-weight:750;letter-spacing:-1.8px;text-decoration:none;color:#233d34}.wordmark span{color:#bd7250}.admin-label{font-size:13px;border-left:1px solid #d6ded7;padding-left:26px;color:#687a72}.admin-header>.quiet{margin-left:auto}.sign-in{max-width:440px;margin:85px auto;padding:24px}.eyebrow{font-size:11px;letter-spacing:1.7px;text-transform:uppercase;font-weight:700;color:#7b806d}h1{font-size:38px;font-weight:550;letter-spacing:-1.4px;line-height:1.16;margin:15px 0}p{font-size:14px;line-height:1.7;color:#6b7770}h2{font-size:19px;letter-spacing:-.4px;font-weight:600;margin:0 0 6px}.sign-in form{margin-top:30px}.sign-in button.primary{width:100%;margin-top:8px}.back{display:block;margin-top:30px;font-size:13px;color:#567366}.dashboard{max-width:1000px;margin:auto;padding:45px 32px 70px}.intro{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:32px}.intro p{margin:12px 0 0}.intro h1{margin:10px 0}.button{display:inline-block;text-decoration:none}nav{display:flex;gap:26px;border-bottom:1px solid #d9e1d9;margin-bottom:28px}nav button{border:0;border-radius:0;background:none;padding:16px 0;color:#748078;font-weight:600}nav button.chosen{color:#294d3b;border-bottom:2px solid #294d3b}.card{background:white;border:1px solid #e0e6de;border-radius:14px;padding:30px;margin-bottom:20px}.section-heading{display:flex;align-items:flex-start;gap:16px;margin-bottom:24px}.section-heading p{margin:0;max-width:650px}.step{background:#f1f4ed;color:#60735b;border-radius:10px;min-width:38px;height:38px;display:grid;place-items:center;font-size:13px;font-weight:600}.section-heading>div{flex:1}label{display:block;font-size:12px;font-weight:650;color:#465c50;margin:20px 0}input:not([type=checkbox]){display:block;box-sizing:border-box;width:100%;background:#fbfcfa;border:1px solid #dce3d9;border-radius:7px;padding:12px 13px;margin:8px 0 0;font-size:13px;font-weight:400;color:#31473b;outline:none;min-width:0}input:focus{border-color:#63896a;box-shadow:0 0 0 3px #eaf0e8}small{display:block;font-size:11px;font-weight:400;line-height:1.6;color:#7a857c;margin-top:7px}button,.button{font-family:inherit;font-size:12px;font-weight:600;border:1px solid transparent;border-radius:7px;padding:11px 16px;cursor:pointer;white-space:nowrap}button:disabled{opacity:.5;cursor:wait}.primary{background:#315740;color:white;border-color:#315740}.secondary{background:white;border-color:#d7e0d5;color:#405a46}.quiet{background:transparent;color:#627260}.danger{background:transparent;color:#a14b37}.input-row{display:flex;align-items:center;gap:10px}.input-row input{margin-top:0}.input-row{margin-top:8px}.two-columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}.two-columns label{margin-top:6px}.optional{font-size:10px;font-weight:400;color:#859080}.note{padding:14px 17px;background:#f6f5ee;border-radius:8px;color:#81816d;font-size:12px;line-height:1.65;margin:8px 0 20px}.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.save-bar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:4px 0 14px}.save-bar p{font-size:12px}.deployment{font-size:11px;text-align:center;color:#8a928a}.deployment a{color:inherit}.alert{padding:13px 17px;border-radius:8px;margin:0 0 20px;font-size:13px}.error{color:#9b4432;background:#fbedE8}.success{color:#375c41;background:#e8f1e6}.folder-browser{border:1px solid #dce5d7;border-radius:10px;padding:16px;background:#fafcf8;margin:14px 0}.folder-heading{display:flex;align-items:center;justify-content:space-between;font-size:12px;overflow-wrap:anywhere;margin-bottom:8px}.folder{display:flex;justify-content:space-between;width:100%;text-align:left;background:white;border-bottom:1px solid #eff2eb;border-radius:0;font-weight:400;color:#436344}.folder-browser>.primary{margin-top:16px}.confirmation{display:flex;gap:12px;align-items:flex-start;padding:15px;background:#fff4e4;line-height:1.6;color:#8a652f}.confirmation input{margin-top:3px}.muted{font-size:12px;color:#818b81}.status{font-size:10px;text-transform:uppercase;letter-spacing:1px;border:1px solid #e0e5dc;padding:5px 9px;border-radius:20px;color:#889180}.status.active{background:#edf5e8;color:#5f7e4b;border-color:#deead6}.invitation{background:#f0f5eb;border-color:#d7e5ca}.invitation a{display:inline-block;color:#54734d;font-size:12px;margin-top:15px}.member{display:flex;align-items:center;gap:14px;padding:19px 0;border-bottom:1px solid #edf0e9}.member:last-child{border:0}.avatar{display:grid;place-items:center;width:36px;height:36px;background:#f0ede2;color:#8c8264;border-radius:50%;font-size:13px}.member-name{flex:1;font-size:13px}.member-name small{margin-top:3px}.empty{padding:35px 0;text-align:center;color:#8b9687;font-size:13px}@media(max-width:640px){.admin-header{padding:0 20px;height:70px;gap:16px}.admin-label{padding-left:16px;font-size:11px}.dashboard{padding:28px 18px}.intro{display:block}.intro>.button{margin-top:18px}h1{font-size:30px}.card{padding:22px 18px}.two-columns{grid-template-columns:1fr;gap:0}.input-row{flex-wrap:wrap}.input-row input{flex:1 1 200px}.save-bar{align-items:flex-start}.save-bar p{margin:0}.section-heading{gap:11px}.section-heading .step{min-width:30px;height:30px}.member{gap:8px;flex-wrap:wrap}.member-name{min-width:150px}.member button{padding:7px 8px}.sign-in{margin:45px auto}}
</style>
