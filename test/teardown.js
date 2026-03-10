module.exports = async function (globalConfig, projectConfig) {
    // Forcefully exit the process after all tests have completed
    // This helps when there are hanging intervals/sockets that Jest's --forceExit cannot kill
    setTimeout(() => {
        process.exit(0);
    }, 500).unref();
};
