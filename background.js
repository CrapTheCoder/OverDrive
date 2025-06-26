const CONFIG_FILE_NAME = 'overdrive.config.json';
let configCache = null;
let configIdCache = null;

async function apiFetch(url, options, token) {
    const fetchOptions = { ...options, headers: { ...options.headers, 'Authorization': `Bearer ${token}` } };
    if (fetchOptions.body instanceof FormData) { delete fetchOptions.headers['Content-Type']; }
    const response = await fetch(url, fetchOptions);
    if (response.status === 401 || response.status === 403) {
        await chrome.identity.removeCachedAuthToken({ token });
        configCache = null; configIdCache = null;
        throw new Error("Authentication error. Please log in again.");
    }
    if (!response.ok) {
        const errorData = await response.json();
        const message = errorData.error?.message || 'Unknown Google API Error';
        throw new Error(`Google API Error: ${message}`);
    }
    return response;
}

function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, (token) => {
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); }
            else if (token) { resolve(token); }
            else { reject(new Error("Token could not be retrieved.")); }
        });
    });
}

async function updateDriveFile(fileId, pdfData, token) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ mimeType: 'application/pdf' })], { type: 'application/json' }));
    form.append('file', new Blob([pdfData], { type: 'application/pdf' }));
    const response = await apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, { method: 'PATCH', body: form }, token);
    return await response.json();
}

async function createDriveFile(fileName, pdfData, token) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: `${fileName}.pdf`, mimeType: 'application/pdf' })], { type: 'application/json' }));
    form.append('file', new Blob([pdfData], { type: 'application/pdf' }));
    const response = await apiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', body: form }, token);
    return await response.json();
}

async function findOrCreateConfig(token) {
    if (configIdCache) return configIdCache;
    const query = `name='${CONFIG_FILE_NAME}' and 'appDataFolder' in parents`;
    const response = await apiFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=appDataFolder&fields=files(id)`, { method: 'GET' }, token);
    const data = await response.json();
    if (data.files && data.files.length > 0) {
        configIdCache = data.files[0].id;
        return configIdCache;
    } else {
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify({ name: CONFIG_FILE_NAME, parents: ['appDataFolder'] })], { type: 'application/json' }));
        form.append('file', new Blob([JSON.stringify({ projects: {} })], { type: 'application/json' }));
        const createResponse = await apiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form }, token);
        const createData = await createResponse.json();
        configCache = { projects: {} };
        configIdCache = createData.id;
        return configIdCache;
    }
}

async function readConfig(token) {
    if (configCache) return configCache;
    const fileId = await findOrCreateConfig(token);
    const response = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { method: 'GET' }, token);
    const config = await response.json();
    configCache = config;
    return config;
}

async function writeConfig(configData, token) {
    const fileId = await findOrCreateConfig(token);
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ mimeType: 'application/json' })], { type: 'application/json' }));
    form.append('file', new Blob([JSON.stringify(configData, null, 2)], { type: 'application/json' }));
    const response = await apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, { method: 'PATCH', body: form }, token);
    configCache = configData;
    return await response.json();
}

async function deleteConfig(token) {
    try {
        const fileId = await findOrCreateConfig(token);
        if (fileId) { await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' }, token); }
    } catch (e) {
        console.warn("Could not delete config file, it may not have existed or auth may have failed.", e.message);
    } finally {
        configCache = null;
        configIdCache = null;
    }
}

function getPdfFromTab(tabId) {
    return new Promise(async (resolve, reject) => {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => {
                    const pdfUrl = document.querySelector('a[aria-label="Download PDF"]')?.href;
                    if (!pdfUrl) return Promise.reject("Could not find Overleaf PDF download link. Is the PDF compiled?");
                    return fetch(pdfUrl).then(res => res.arrayBuffer());
                }
            });
            if (results && results[0] && results[0].result) { resolve(results[0].result); }
            else { reject(new Error("Failed to retrieve PDF from the page. Check console for details.")); }
        } catch (e) { reject(e); }
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handlers = {
        'get-initial-state': async () => {
            let token;
            try { token = await getAuthToken(false); }
            catch (error) { sendResponse({ status: 'success', authenticated: false, projects: {} }); return; }
            try {
                const config = await readConfig(token);
                sendResponse({ status: 'success', authenticated: true, projects: config.projects });
            } catch (error) {
                if (error.message.includes("Authentication error")) { sendResponse({ status: 'success', authenticated: false, projects: {} }); }
                else { sendResponse({ status: 'error', message: `Failed to load config: ${error.message}` }); }
            }
        },
        'login': async () => {
            try {
                const token = await getAuthToken(true);
                configCache = null; configIdCache = null;
                const config = await readConfig(token);
                sendResponse({ status: 'success', authenticated: true, projects: config.projects });
            } catch (error) { sendResponse({ status: 'error', message: `Login failed: ${error.message}` }); }
        },
        'logout': async () => {
            try {
                const token = await getAuthToken(false);
                if (token) {
                    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
                    await chrome.identity.removeCachedAuthToken({ token });
                }
                configCache = null; configIdCache = null;
                sendResponse({ status: 'success' });
            } catch (error) { sendResponse({ status: 'error', message: `Logout failed: ${error.message}` }); }
        },
        'reset': async () => {
            try {
                const token = await getAuthToken(false);
                if (token) {
                    await deleteConfig(token);
                    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
                    await chrome.identity.removeCachedAuthToken({ token });
                    configCache = null; configIdCache = null;
                }
                sendResponse({ status: 'success', message: 'Extension data has been reset.' });
            } catch (error) { sendResponse({ status: 'error', message: `Reset failed: ${error.message}` }); }
        },
        'save-project': async () => {
            try {
                const token = await getAuthToken(true);
                const config = await readConfig(token);
                const newProject = message.project;
                const pdfData = await getPdfFromTab(message.tabId);
                const newFile = await createDriveFile(newProject.name, pdfData, token);
                config.projects[newProject.id] = { name: newProject.name, driveFileId: newFile.id };
                await writeConfig(config, token);
                sendResponse({ status: 'success', message: 'Project saved!', projects: config.projects });
            } catch (error) { sendResponse({ status: 'error', message: `Save failed: ${error.message}` }); }
        },
        'edit-project': async () => {
            const { projectId, newName } = message;
            try {
                const token = await getAuthToken(true);
                const config = await readConfig(token);
                const projectToEdit = config.projects[projectId];
                if (!projectToEdit) { throw new Error("Project not found in config."); }
                const fileMetadata = { name: `${newName}.pdf` };
                await apiFetch(`https://www.googleapis.com/drive/v3/files/${projectToEdit.driveFileId}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fileMetadata)
                }, token);
                projectToEdit.name = newName;
                await writeConfig(config, token);
                sendResponse({ status: 'success', message: 'Project saved!', projects: config.projects });
            } catch (error) { sendResponse({ status: 'error', message: `Save failed: ${error.message}` }); }
        },
        'delete-project': async () => {
            const { projectId } = message;
            try {
                const token = await getAuthToken(true);
                const config = await readConfig(token);
                const projectToDelete = config.projects[projectId];
                if (!projectToDelete) { throw new Error("Project not found in config."); }
                await apiFetch(`https://www.googleapis.com/drive/v3/files/${projectToDelete.driveFileId}`, { method: 'DELETE' }, token);
                delete config.projects[projectId];
                await writeConfig(config, token);
                sendResponse({ status: 'success', message: 'Project deleted!', projects: config.projects });
            } catch (error) {
                if (error.message.includes("File not found")) {
                    try {
                        const token = await getAuthToken(false);
                        const config = await readConfig(token);
                        if (config.projects[projectId]) {
                            delete config.projects[projectId];
                            await writeConfig(config, token);
                            sendResponse({ status: 'success', message: 'Removed stale project link.', projects: config.projects });
                            return;
                        }
                    } catch (finalError) {
                        sendResponse({ status: 'error', message: `Cleanup failed: ${finalError.message}` });
                        return;
                    }
                }
                sendResponse({ status: 'error', message: `Delete failed: ${error.message}` });
            }
        },
        'sync-project': async () => {
            const { projectId, tabId } = message;
            try {
                chrome.runtime.sendMessage({ type: 'status-update', message: 'Syncing: Authenticating...' });
                const token = await getAuthToken(true);
                const config = await readConfig(token);
                const project = config.projects[projectId];
                if (!project) throw new Error("Project not found. It may have been deleted on another device.");
                chrome.runtime.sendMessage({ type: 'status-update', message: 'Syncing: Fetching PDF...' });
                const pdfData = await getPdfFromTab(tabId);
                chrome.runtime.sendMessage({ type: 'status-update', message: 'Syncing: Uploading to Drive...' });
                await updateDriveFile(project.driveFileId, pdfData, token);
                sendResponse({ status: 'success', message: `Sync complete for "${project.name}"!` });
            } catch (error) { sendResponse({ status: 'error', message: `Sync failed: ${error.message}` }); }
        }
    };

    if (handlers[message.type]) {
        handlers[message.type]();
        return true;
    }
});