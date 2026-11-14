export default {
  name: 'echo-test',
  description: '验证动态加载的测试插件',
  tools: [
    {
      name: 'echo_test',
      description: '回显输入',
      parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      async execute(input) { return 'echo: ' + input.msg; }
    }
  ],
  async onUnload() {}
};