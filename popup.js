const projectSelect = document.getElementById('projectSelect');
const syncButton = document.getElementById('syncButton');
const addButton = document.getElementById('addButton');
const statusDiv = document.getElementById('status');
const resetButton = document.getElementById('resetButton');

let overleafProjectId = null;

function setUIState(isBusy, message) {
    statusDiv.textContent = message;
    if (isBusy) {
        syncButton.disabled = true;
        addButton.disabled = true;
    }
}

function populateProjectList(projects) {
    projectSelect.innerHTML = '';
    if (projects && projects.length > 0) {
        projects.forEach(proj => {
            const option = new Option(proj.projectName, proj.driveFileId);
            option.dataset.project = JSON.stringify(proj);
            projectSelect.appendChild(option);
        });
        syncButton.disabled = false;
    } else {
        const option = new Option('-- No projects linked yet --', '');
        projectSelect.appendChild(option);
        syncButton.disabled = true;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    setUIState(true, 'Initializing...');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab.url && tab.url.includes("overleaf.com/project/")) {
        addButton.disabled = false;
        overleafProjectId = tab.url.split('/')[2];
        statusDiv.textContent = 'Fetching config from Google Drive...';

        try {
            const response = await chrome.runtime.sendMessage({ action: 'get_config' });
            if (!response.success) throw new Error(response.error);
            populateProjectList(response.data.projects);
            statusDiv.textContent = 'Ready.';
        } catch (error) {
            setUIState(true, `Error: ${error.message}`);
        }
    } else {
        setUIState(true, 'Go to an Overleaf project page to use this.');
        projectSelect.innerHTML = '<option>-- N/A --</option>';
    }
});

addButton.addEventListener('click', async () => {
    const projectName = prompt("Enter a name for this new project (e.g., 'My Resume'):");
    if (!projectName || !projectName.trim()) return;

    const driveUrl = prompt("Now, paste the full Google Drive PDF link to sync with:");
    if (!driveUrl) return;

    let driveFileId = null;
    if (driveUrl.includes('/d/')) {
        driveFileId = driveUrl.split('/d/')[1].split('/')[0];
    } else if (driveUrl.includes('id=')) {
        try { driveFileId = new URL(driveUrl).searchParams.get("id"); } catch (e) {}
    }

    if (!driveFileId) {
        alert("Invalid or unrecognized Google Drive link format.");
        return;
    }

    setUIState(true, 'Saving new project to Drive...');
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'add_project',
            projectData: { projectName: projectName.trim(), overleafProjectId, driveFileId }
        });
        if (!response.success) throw new Error(response.error);
        populateProjectList(response.data.projects);
        projectSelect.value = driveFileId;
        statusDiv.textContent = 'Project added successfully!';
    } catch (error) {
        statusDiv.textContent = `Error: ${error.message}`;
    } finally {
        addButton.disabled = false;
    }
});

syncButton.addEventListener('click', async () => {
    const selectedOption = projectSelect.options[projectSelect.selectedIndex];
    if (!selectedOption || !selectedOption.dataset.project) {
        alert("Please select a project to sync.");
        return;
    }
    const project = JSON.parse(selectedOption.dataset.project);

    setUIState(true, `Syncing '${project.projectName}'...`);
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: () => document.querySelector('a[aria-label="Download PDF"]')?.href
        });
        const pdfUrl = results?.[0]?.result;
        if (!pdfUrl) throw new Error("Could not find PDF link. Please recompile in Overleaf.");

        const response = await chrome.runtime.sendMessage({
            action: 'upload',
            pdfUrl,
            driveFileId: project.driveFileId,
            newFileName: project.projectName + '.pdf'
        });
        if (!response.success) throw new Error(response.error);
        statusDiv.textContent = 'Sync successful!';
    } catch (error) {
        statusDiv.textContent = `Error: ${error.message}`;
    } finally {
        addButton.disabled = false;
        syncButton.disabled = projectSelect.value === '';
    }
});

resetButton.addEventListener('click', async () => {
    if (!confirm("This will clear the extension's authentication data and require you to sign in again. Are you sure?")) return;
    setUIState(true, 'Resetting authentication...');
    try {
        const response = await chrome.runtime.sendMessage({ action: 'reset_auth' });
        if (!response.success) throw new Error(response.error);
        statusDiv.textContent = 'Reset successful! Close and reopen this popup to sign in.';
    } catch (error) {
        statusDiv.textContent = `Reset failed: ${error.message}`;
    }
});