const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { Player } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Add basic web server for health checks (required for Render.com)
const express = require('express');
const app = express();
const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
    res.json({
        message: 'Discord Music Bot is running!',
        status: 'online',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        pid: process.pid
    });
});

// Start server immediately
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health check server running on port ${PORT}`);
    console.log(`📡 Server accessible at http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

// Create player instance
const player = new Player(client, {
    ytdlOptions: {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        filter: 'audioonly'
    },
    skipFFmpeg: false
});

// Store player instance on client for access in commands
client.player = player;

// Initialize extractors after player is created
async function initializeExtractors() {
    try {
        await player.extractors.loadMulti(DefaultExtractors);
        console.log('✅ Extractors loaded successfully');
        console.log('📦 Available extractors:', player.extractors.size);
    } catch (error) {
        console.error('❌ Failed to register extractors:', error);
        console.log('⚠️ Bot will continue without extractors');
    }
}

// Create commands collection
client.commands = new Collection();

// Load commands
const commandFolders = fs.readdirSync('./commands');
for (const folder of commandFolders) {
    const commandFiles = fs.readdirSync(`./commands/${folder}`).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const command = require(`./commands/${folder}/${file}`);
        client.commands.set(command.data.name, command);
    }
}

// Load events
const eventFiles = fs.readdirSync('./events').filter(file => file.endsWith('.js'));
for (const file of eventFiles) {
    const event = require(`./events/${file}`);
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
    } else {
        client.on(event.name, (...args) => event.execute(...args, client));
    }
}

// Player events
player.events.on('playerStart', (queue, track) => {
    const { createNowPlayingEmbed } = require('./utils/embeds');
    const { createMusicControlButtons } = require('./utils/buttons');

    // Delete previous nowplaying message if it exists
    if (queue.metadata && queue.metadata.nowPlayingMessage) {
        queue.metadata.nowPlayingMessage.delete().catch(console.error);
    }

    if (queue.metadata && queue.metadata.channel) {
        queue.metadata.channel.send({
            embeds: [createNowPlayingEmbed(track)],
            components: [createMusicControlButtons()]
        }).then(message => {
            // Store the message reference for later deletion
            queue.metadata.nowPlayingMessage = message;
        }).catch(console.error);
    }
});

player.events.on('audioTrackAdd', (queue, track) => {
    if (queue.metadata && queue.metadata.channel) {
        const embed = {
            color: 0x00ff00,
            title: '🎵 Track Added to Queue',
            description: `**${track.title}** by ${track.author}`,
            thumbnail: { url: track.thumbnail },
            fields: [
                { name: 'Duration', value: track.duration, inline: true },
                { name: 'Position in Queue', value: `${queue.tracks.size}`, inline: true }
            ],
            timestamp: new Date()
        };
        queue.metadata.channel.send({ embeds: [embed] }).then(message => {
            // Auto-delete after 2 seconds
            setTimeout(() => {
                if (message.deletable) {
                    message.delete().catch(console.error);
                }
            }, 2000);
        }).catch(console.error);
    }
});

player.events.on('emptyQueue', (queue) => {
    // Delete any existing nowplaying messages when queue ends
    if (queue.metadata && queue.metadata.nowPlayingMessage) {
        queue.metadata.nowPlayingMessage.delete().catch(console.error);
        queue.metadata.nowPlayingMessage = null;
    }

    if (queue.metadata && queue.metadata.channel) {
        const embed = {
            color: 0xffff00,
            title: '🎵 Queue Finished',
            description: 'All tracks have been played. Add more music or use `/play` to continue!',
            timestamp: new Date()
        };
        queue.metadata.channel.send({ embeds: [embed] }).then(message => {
            // Auto-delete after 30 seconds
            setTimeout(() => {
                if (message.deletable) {
                    message.delete().catch(console.error);
                }
            }, 30000);
        }).catch(console.error);
    }
});

player.events.on('playerError', (queue, error) => {
    console.error('Player error:', error);
    
    if (queue.metadata && queue.metadata.channel) {
        let errorMsg = 'An error occurred while playing the track.';
        
        if (error.message.includes('NoResultError') || error.code === 'ERR_NO_RESULT') {
            errorMsg = 'Cannot extract audio stream from this track.';
        } else if (error.message.includes('age-restricted')) {
            errorMsg = 'Track is age-restricted.';
        } else if (error.message.includes('unavailable')) {
            errorMsg = 'Track is unavailable.';
        }
        
        const embed = {
            color: 0xff6b00,
            title: '⚠️ Playback Error',
            description: `${errorMsg} ${queue.tracks.size > 0 ? 'Skipping to next track...' : ''}`,
            timestamp: new Date()
        };
        
        queue.metadata.channel.send({ embeds: [embed] }).then(message => {
            setTimeout(() => {
                if (message.deletable) {
                    message.delete().catch(console.error);
                }
            }, 5000);
        });
    }
    
    // Auto-skip to next track if available
    if (queue.tracks.size > 0) {
        setTimeout(() => {
            try {
                queue.node.skip();
            } catch (skipError) {
                console.error('Auto-skip error:', skipError);
            }
        }, 1000);
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialize bot
client.once('ready', async () => {
    console.log('🤖 Bot is ready!');
    await initializeExtractors();
});

// Login with error handling
if (!process.env.DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN not found in environment variables!');
    console.log('📝 Please add your Discord bot token to the Secrets tab');
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('❌ Failed to login:', error.message);
    console.log('📝 Please check your DISCORD_TOKEN in the Secrets tab');
    process.exit(1);
});
