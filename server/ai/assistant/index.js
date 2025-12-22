const { AssistantService } = require('./assistant-service');

async function createAssistantService(config) {
    const service = new AssistantService(config);
    await service.init();
    return service;
}

module.exports = {
    createAssistantService
};
