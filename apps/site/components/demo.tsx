"use client"

import React, { useState } from "react"
import ClaudeChatInput from "./ui/claude-style-chat-input"

type SentMessage = {
  message: string
  filesCount: number
  model: string
}

const ChatboxDemo = () => {
  const [messages, setMessages] = useState<SentMessage[]>([])

  const handleSendMessage = (payload: {
    message: string
    files: Array<{ id: string }>
    model: string
    isThinkingEnabled: boolean
  }) => {
    setMessages((prev) => [...prev, { message: payload.message, filesCount: payload.files.length, model: payload.model }])
  }

  const currentHour = new Date().getHours()
  let greeting = "Good morning"
  if (currentHour >= 12 && currentHour < 18) greeting = "Good afternoon"
  else if (currentHour >= 18) greeting = "Good evening"

  return (
    <div className="min-h-screen w-full bg-[#fcfcf9] dark:bg-[#202123] flex flex-col items-center justify-center p-4 font-sans text-text-100 transition-colors duration-200">
      <div className="w-full max-w-3xl mb-8 sm:mb-12 text-center animate-fade-in">
        <div className="w-24 h-24 mx-auto mb-6 flex items-center justify-center overflow-hidden rounded-full">
          <img
            src="https://images.unsplash.com/photo-1518773553398-650c184e0bb3?auto=format&fit=crop&w=200&q=80"
            alt="Logo"
            className="w-full h-full object-cover"
          />
        </div>
        <h1 className="text-3xl sm:text-4xl font-serif font-light text-text-200 mb-3 tracking-tight">{greeting}</h1>
      </div>

      <ClaudeChatInput onSendMessage={handleSendMessage} />

      <div className="mt-6 w-full max-w-2xl space-y-2">
        {messages.slice(-3).map((item, idx) => (
          <div key={`${item.model}-${idx}`} className="text-sm text-text-300">
            {item.model}: {item.message || "(attachments only)"} [{item.filesCount} file(s)]
          </div>
        ))}
      </div>
    </div>
  )
}

export default ChatboxDemo
