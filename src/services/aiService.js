/**
 * Servicio de IA con OpenAI ChatGPT
 */

import OpenAI from "openai";
import { getConfig } from '../config/env.js';

let _openaiClient = null;

/**
 * Obtiene el cliente de OpenAI (lazy initialization)
 */
export function getOpenAIClient() {
  if (!_openaiClient) {
    const config = getConfig();
    const apiKey = config.openai.apiKey;
    
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY no está configurada. Verifica las variables de entorno.");
    }
    
    _openaiClient = new OpenAI({ apiKey });
    console.log("✅ Cliente OpenAI inicializado correctamente");
  }
  return _openaiClient;
}

/**
 * Compatibilidad: Mantener nombre anterior para no romper código existente
 * @deprecated Usar getOpenAIClient() en su lugar
 */
export function getAnthropicClient() {
  return getOpenAIClient();
}

/**
 * Genera respuesta de IA con herramientas
 */
export async function generateAIResponse(query, history = [], tools = [], systemPrompt = '') {
  const openai = getOpenAIClient();
  
  const messages = [];
  
  // Añadir system prompt si existe
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  
  // Convertir historial al formato de OpenAI
  messages.push(...(history || []).map(m => ({ 
    role: m.role === 'ai' ? 'assistant' : 'user', 
    content: m.content 
  })));
  
  // Añadir mensaje actual
  messages.push({ role: "user", content: query });

  // Convertir herramientas de formato Claude a formato OpenAI si existen
  const openaiTools = tools.length > 0 ? tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || tool.inputSchema || {}
    }
  })) : undefined;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    messages: messages,
    tools: openaiTools,
    tool_choice: openaiTools ? "auto" : undefined
  });

  // Convertir respuesta de OpenAI a formato similar a Claude para compatibilidad
  const choice = response.choices[0];
  
  // Si hay tool calls, devolver en formato compatible
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    return {
      stop_reason: 'tool_use',
      content: choice.message.tool_calls.map(tc => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}')
      }))
    };
  }
  
  // Respuesta normal de texto
  return {
    stop_reason: 'end_turn',
    content: [{
      type: 'text',
      text: choice.message.content || ''
    }]
  };
}



