// zip -r sns_to_slack_notification.zip .

const axios = require("axios");

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL

exports.handler = async (event, context) => {
    console.log("Received event:", JSON.stringify(event, null, 2));

    try {
        // Validate SNS message
        if (!event.Records || !event.Records[0].Sns) {
            throw new Error("Invalid event structure: Missing SNS data");
        }

        // Parse SNS message
        const snsMessage = event.Records[0].Sns;
        const message = JSON.parse(snsMessage.Message);

        // Extract detailed alarm information
        const {
            AlarmName,
            NewStateValue,
            NewStateReason,
            StateChangeTime,
            Region,
            Trigger
        } = message;

        const {
            MetricName,
            Namespace,
            Dimensions,
            StatisticType,
            Threshold,
            Period
        } = Trigger || {};

        const dimensionDetails = Dimensions
            ? Dimensions.map(d => `*${d.Name}:* ${d.Value}`).join("\n")
            : "N/A";

        // Format the Slack message
        const slackMessage = {
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: `🚨 Alarm Triggered: ${AlarmName || 'Unnamed Alarm'}`,
                        emoji: true
                    }
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Status:* ${NewStateValue}\n*Reason:* ${NewStateReason}`
                    }
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*Time:*\n${StateChangeTime || 'N/A'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Region:*\n${Region || 'N/A'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Metric:*\n${MetricName || 'N/A'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Namespace:*\n${Namespace || 'N/A'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Threshold:*\n${Threshold || 'N/A'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Statistic:*\n${StatisticType || 'N/A'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Period:*\n${Period ? `${Period} seconds` : 'N/A'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Dimensions:*\n${dimensionDetails}`
                        }
                    ]
                }
            ]
        };

        // Send notification to Slack
        const response = await axios.post(SLACK_WEBHOOK_URL, slackMessage, {
            headers: { "Content-Type": "application/json" }
        });

        console.log("Slack notification sent successfully:", response.status);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Notification sent successfully" })
        };
    } catch (error) {
        console.error("Error processing SNS message:", error.message, error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Failed to process SNS message" })
        };
    }
};