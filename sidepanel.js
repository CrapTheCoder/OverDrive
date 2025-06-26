document.addEventListener('DOMContentLoaded', () => {
    const views = {
        login: document.getElementById('loginView'),
        main: document.getElementById('mainView'),
        add: document.getElementById('addView'),
        edit: document.getElementById('editView'),
    };
    const statusEl = document.getElementById('status');
    const settingsEl = document.getElementById('settings');
    const projectSelect = document.getElementById('projectSelect');

    const syncButton = document.getElementById('syncButton');
    const addButton = document.getElementById('addButton');
    const editButton = document.getElementById('editButton');
    const deleteButton = document.getElementById('deleteButton');

    const projectNameInput = document.getElementById('projectNameInput');
    const saveButton = document.getElementById('saveButton');
    const cancelButton = document.getElementById('cancelButton');

    const nameInput = document.getElementById('nameInput');
    const saveEditButton = document.getElementById('saveEditButton');
    const cancelEditButton = document.getElementById('cancelEditButton');

    const loginButton = document.getElementById('loginButton');
    const resetButton = document.getElementById('resetButton');
    const logoutButton = document.getElementById('logoutButton');


    let currentTab = null;
    let overleafProjectId = null;
    let statusTimeout;

    const updateStatus = (message, isError = false, persist = false) => {
        statusEl.textContent = message;
        statusEl.style.color = isError ? 'var(--danger-color)' : 'var(--text-secondary-color)';
        clearTimeout(statusTimeout);
        if (message && !persist) {
            statusTimeout = setTimeout(() => statusEl.textContent = '', 5000);
        }
    };

    const setView = (viewName) => {
        Object.values(views).forEach(v => v.classList.remove('active'));
        if (views[viewName]) views[viewName].classList.add('active');

        const showSettings = ['main', 'add', 'edit'].includes(viewName);
        settingsEl.style.display = showSettings ? 'block' : 'none';
    };

    const populateProjectSelect = (projects, selectedId = null) => {
        const lastSelectedValue = projectSelect.value;
        projectSelect.innerHTML = '';
        const projectIds = Object.keys(projects);

        if (projectIds.length === 0) {
            projectSelect.innerHTML = '<option value="">-- No projects linked --</option>';
        } else {
            projectIds.forEach(id => {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = projects[id].name;
                projectSelect.appendChild(option);
            });
        }

        const idToSelect = selectedId ||
            (projects[lastSelectedValue] ? lastSelectedValue :
                (overleafProjectId && projects[overleafProjectId] ? overleafProjectId :
                    (projectIds[0] || '')));

        projectSelect.value = idToSelect;
        updateMainViewButtons();
    };

    const updateMainViewButtons = () => {
        const hasSelection = !!projectSelect.value;
        syncButton.disabled = !hasSelection;
        editButton.disabled = !hasSelection;
        deleteButton.disabled = !hasSelection;
    };

    const toggleMainButtons = (disabled) => {
        syncButton.disabled = disabled;
        addButton.disabled = disabled;
        if (disabled) {
            editButton.disabled = true;
            deleteButton.disabled = true;
        } else {
            updateMainViewButtons();
        }
    };

    const sendMessage = (payload, callback) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                const errorMessage = `Error: ${chrome.runtime.lastError.message}`;
                updateStatus(errorMessage, true);
                if (callback) callback({ status: 'error', message: errorMessage });
            } else if (callback) {
                callback(response);
            }
        });
    };

    const handleInitialState = (response) => {
        if (response.status === 'success') {
            if (response.authenticated) {
                updateStatus('');
                populateProjectSelect(response.projects);
                setView('main');
            } else {
                updateStatus('Please log in to continue.', false, true);
                setView('login');
            }
        } else {
            updateStatus(response.message || 'Failed to get initial state.', true, true);
        }
    };

    const handleLogin = () => {
        updateStatus('Opening Google login...', false, true);
        loginButton.disabled = true;
        sendMessage({ type: 'login' }, response => {
            if (response.status === 'success') {
                handleInitialState(response);
            } else {
                updateStatus(response.message, true);
            }
            loginButton.disabled = false;
        });
    };

    const handleLogout = () => {
        updateStatus('Logging out...');
        sendMessage({ type: 'logout' }, response => {
            if (response.status === 'success') {
                updateStatus('Logged out. Please login to use the extension.', false, true);
                setView('login');
            } else {
                updateStatus(response.message, true);
            }
        });
    };

    const handleReset = () => {
        const confirmation = 'Are you sure? This will delete your configuration file from Google Drive and log you out. This action cannot be undone.';
        if (confirm(confirmation)) {
            updateStatus('Resetting...');
            sendMessage({ type: 'reset' }, response => {
                if (response.status === 'success') {
                    updateStatus(response.message);
                    setView('login');
                } else {
                    updateStatus(response.message, true);
                }
            });
        }
    };

    const handleSync = () => {
        const projectId = projectSelect.value;
        if (!projectId) return;

        toggleMainButtons(true);
        updateStatus('Starting sync...', false, true);

        sendMessage({ type: 'sync-project', projectId, tabId: currentTab.id }, response => {
            if (response.status === 'error') {
                updateStatus(response.message, true);
            } else {
                updateStatus(response.message);
            }
            toggleMainButtons(false);
        });
    };

    const handleSave = () => {
        const name = projectNameInput.value.trim();
        if (!name) {
            updateStatus('Project name is required.', true);
            return;
        }

        saveButton.disabled = true;
        cancelButton.disabled = true;
        updateStatus('Saving project...');

        const payload = { type: 'save-project', tabId: currentTab.id, project: { id: overleafProjectId, name } };
        sendMessage(payload, response => {
            if (response.status === 'success') {
                updateStatus(response.message);
                populateProjectSelect(response.projects, overleafProjectId);
                setView('main');
            } else {
                updateStatus(response.message, true);
            }
            saveButton.disabled = false;
            cancelButton.disabled = false;
        });
    };

    const handleEdit = () => {
        const projectId = projectSelect.value;
        const newName = nameInput.value.trim();
        if (!newName) {
            updateStatus('Project name cannot be empty.', true);
            return;
        }

        saveEditButton.disabled = true;
        cancelEditButton.disabled = true;
        updateStatus('Saving...');

        sendMessage({ type: 'edit-project', projectId, newName }, response => {
            if (response.status === 'success') {
                updateStatus(response.message);
                populateProjectSelect(response.projects, projectId);
                setView('main');
            } else {
                updateStatus(response.message, true);
            }
            saveEditButton.disabled = false;
            cancelEditButton.disabled = false;
        });
    };

    const handleDelete = () => {
        const projectId = projectSelect.value;
        const selectedOption = projectSelect.options[projectSelect.selectedIndex];
        if (!projectId || !selectedOption) return;

        const confirmation = `Are you sure you want to delete "${selectedOption.text}"? This will delete the PDF from your Google Drive and cannot be undone.`;
        if (confirm(confirmation)) {
            toggleMainButtons(true);
            updateStatus('Deleting...');

            sendMessage({ type: 'delete-project', projectId }, response => {
                if (response.status === 'success') {
                    updateStatus(response.message);
                    populateProjectSelect(response.projects);
                } else {
                    updateStatus(response.message, true);
                }
                toggleMainButtons(false);
            });
        }
    };

    const setupEventListeners = () => {
        loginButton.addEventListener('click', handleLogin);
        logoutButton.addEventListener('click', handleLogout);
        resetButton.addEventListener('click', handleReset);
        syncButton.addEventListener('click', handleSync);
        saveButton.addEventListener('click', handleSave);
        editButton.addEventListener('click', () => {
            const selectedOption = projectSelect.options[projectSelect.selectedIndex];
            nameInput.value = selectedOption ? selectedOption.text : '';
            setView('edit');
        });
        deleteButton.addEventListener('click', handleDelete);
        addButton.addEventListener('click', () => {
            projectNameInput.value = currentTab.title.replace(" - Overleaf", "").trim();
            setView('add');
        });
        cancelButton.addEventListener('click', () => setView('main'));
        saveEditButton.addEventListener('click', handleEdit);
        cancelEditButton.addEventListener('click', () => setView('main'));
        projectSelect.addEventListener('change', updateMainViewButtons);
        chrome.runtime.onMessage.addListener(msg => {
            if (msg.type === 'status-update') {
                updateStatus(msg.message, false, true);
            }
        });
    };

    const initialize = async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.url && tab.url.includes('overleaf.com/project/')) {
                currentTab = tab;
                const match = tab.url.match(/overleaf\.com\/project\/([a-f0-9]+)/);
                overleafProjectId = match ? match[1] : null;
            } else {
                document.body.innerHTML = `<div class="container" style="text-align: center; justify-content: center; height: 100%; align-items: center;"><p>Please navigate to an Overleaf project page to use this extension.</p></div>`;
                return;
            }

            setupEventListeners();
            sendMessage({ type: 'get-initial-state' }, handleInitialState);

        } catch (error) {
            console.error("Initialization failed:", error);
            updateStatus("An unexpected error occurred during startup.", true, true);
        }
    };

    initialize();
});